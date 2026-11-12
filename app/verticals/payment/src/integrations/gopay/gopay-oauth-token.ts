import { Cache, Context, Duration, Effect, Exit, Layer, Match, Option, Redacted, Schema } from 'effect';
import { HttpClientRequest } from 'effect/http';

import type { GatewayCredentialSecretRef } from '../../../shared/domain/psp-configuration.ts';
import { ProviderCredentialStore } from '../psp/credentials.ts';
import type { ProviderCredentialMaterial } from '../psp/credentials.ts';
import { ProviderHttp } from '../psp/provider-http.ts';
import { GatewayProviderUnavailable } from '../psp/psp-errors.ts';
import type { GatewayProviderUnavailableError } from '../psp/psp-errors.ts';
import type { GatewayExecutionTarget } from '../psp/psp-request.ts';

/**
 * GoPay OAuth2 access tokens (#1154, #1158; https://doc.gopay.com/#obtaining-the-access-token). A
 * client-credentials token with scope `payment-all` is obtained through `ProviderHttp.read` (the token
 * POST creates no payment effect, so it is retried like a read) and cached per (binding, credential
 * revision) for `expires_in - 60 s`. A rotation produces a new revision and therefore a new token; a
 * token is never shared between bindings. Failures are never cached.
 *
 * Nothing here logs; a failure carries only a fixed reason code, never the credential or a body.
 */

/** GoPay REST API roots per binding environment (doc.gopay.com "Environments"). */
const GOPAY_API_BASE_URLS = {
  LIVE: 'https://gate.gopay.cz/api',
  SANDBOX: 'https://gw.sandbox.gopay.com/api',
} as const;

const GopayEnvironmentSchema = Schema.Literals(['LIVE', 'SANDBOX']);

/**
 * Token path below the API root. doc.gopay.com documents `POST /api/oauth2/token`; that the live
 * gateway serves it under the same `/api` root as the payment endpoints is UNVERIFIED until the
 * W5-SANDBOX run.
 */
const GOPAY_TOKEN_PATH = '/oauth2/token';
const GOPAY_TOKEN_REQUEST_BODY = 'grant_type=client_credentials&scope=payment-all';
/** A token is dropped this long before GoPay expires it, so no request is sent with a token about to lapse. */
const GOPAY_TOKEN_EXPIRY_MARGIN_SECONDS = 60;
const GOPAY_TOKEN_CACHE_CAPACITY = 256;

/** The GoPay API root of a binding environment; None for an environment GoPay does not have. */
export const gopayApiBaseUrl = (environment: string): Option.Option<string> =>
  Schema.decodeUnknownOption(GopayEnvironmentSchema)(environment).pipe(
    Option.map((known) => GOPAY_API_BASE_URLS[known]),
  );

const GopayTokenResponseSchema = Schema.Struct({
  access_token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  expires_in: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
  token_type: Schema.Literals(['bearer', 'Bearer']),
});
const decodeTokenResponse = Schema.decodeUnknownOption(Schema.fromJsonString(GopayTokenResponseSchema));

interface GopayAccessToken {
  readonly accessToken: Redacted.Redacted;
  readonly lifetime: Duration.Duration;
}

/** Cache key, compared structurally. Environment and secret ref are fixed by the binding revision. */
interface GopayTokenKey {
  readonly bindingId: string;
  readonly credentialRevision: number;
  readonly credentialSecretRef: GatewayCredentialSecretRef;
  readonly environment: string;
}

const unavailable = (reason: string): GatewayProviderUnavailableError =>
  new GatewayProviderUnavailable({ code: 'gateway_provider_unavailable', family: 'GOPAY', reason });

const gopayClientCredentials = (material: ProviderCredentialMaterial) =>
  Match.value(material).pipe(
    Match.tag('GOPAY', ({ clientId, clientSecret }) => Effect.succeed({ clientId, clientSecret })),
    Match.orElse(() => Effect.fail(unavailable('credential_entry_invalid'))),
  );

const tokenKeyOf = (target: GatewayExecutionTarget): GopayTokenKey => ({
  bindingId: target.bindingId,
  credentialRevision: target.credentialRevision,
  credentialSecretRef: target.credentialSecretRef,
  environment: target.binding.environment,
});

interface GopayOAuthTokenContract {
  /** A bearer token of the target's binding and credential revision; cached until `expires_in - 60 s`. */
  readonly accessToken: (
    target: GatewayExecutionTarget,
  ) => Effect.Effect<Redacted.Redacted, GatewayProviderUnavailableError>;
  /** Drops the cached token of the target (GoPay answered 401/403 with it). */
  readonly invalidate: (target: GatewayExecutionTarget) => Effect.Effect<void>;
}

export class GopayOAuthToken extends Context.Service<GopayOAuthToken, GopayOAuthTokenContract>()(
  '@app/payment/integrations/gopay/gopay-oauth-token/GopayOAuthToken',
) {}

const makeGopayOAuthToken = Effect.gen(function* makeGopayOAuthTokenEffect() {
  const http = yield* ProviderHttp;
  const credentials = yield* ProviderCredentialStore;

  const fetchToken = Effect.fn('GopayOAuthToken.fetchToken')(function* fetchTokenEffect(key: GopayTokenKey) {
    const baseUrl = yield* Effect.fromOption(gopayApiBaseUrl(key.environment), () =>
      unavailable('environment_mismatch'),
    );
    const material = yield* credentials.resolve({ family: 'GOPAY', secretRef: key.credentialSecretRef });
    const { clientId, clientSecret } = yield* gopayClientCredentials(material);
    const request = HttpClientRequest.post(`${baseUrl}${GOPAY_TOKEN_PATH}`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.basicAuth(clientId, clientSecret),
      HttpClientRequest.bodyText(GOPAY_TOKEN_REQUEST_BODY, 'application/x-www-form-urlencoded'),
    );
    const response = yield* http.read({ family: 'GOPAY', request });
    if (response.status !== 200) {
      return yield* Effect.fail(unavailable('gopay_token_rejected'));
    }
    const decoded = yield* Effect.fromOption(decodeTokenResponse(response.bodyText), () =>
      unavailable('gopay_token_response_invalid'),
    );
    const token: GopayAccessToken = {
      accessToken: Redacted.make(decoded.access_token),
      lifetime: Duration.seconds(Math.max(0, decoded.expires_in - GOPAY_TOKEN_EXPIRY_MARGIN_SECONDS)),
    };
    return token;
  });

  const cache = yield* Cache.makeWith(fetchToken, {
    capacity: GOPAY_TOKEN_CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? exit.value.lifetime : Duration.zero),
  });

  return {
    accessToken: (target) => Cache.get(cache, tokenKeyOf(target)).pipe(Effect.map(({ accessToken }) => accessToken)),
    invalidate: (target) => Cache.invalidate(cache, tokenKeyOf(target)),
  } satisfies GopayOAuthTokenContract;
});

/** Requires `ProviderHttp` and `ProviderCredentialStore`; reads no credential and sends nothing while building. */
export const GopayOAuthTokenLive = Layer.effect(GopayOAuthToken, makeGopayOAuthToken);
