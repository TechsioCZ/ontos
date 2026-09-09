import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import type { ApiKeyGatewayContextClientOptions } from '@app/shared-contracts/server/gateway-context-api-key';
import type { GatewayContextClientError, GatewayContextResponse } from '@app/shared-contracts';
import { Config, Effect, Layer, Redacted, Schema } from 'effect';

import { CommerceFxGatewayCredentialService } from '../shared/domain/commerce-fx-gateway-credential.ts';
import type {
  CommerceFxGatewayCredentialIssuer,
  CommerceFxGatewayCredentialRequest,
} from '../shared/domain/commerce-fx-gateway-credential.ts';
import { PurchaseLimitFxUnavailableSchema } from '../shared/domain/purchase-limit-fx-port.ts';

const httpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'Shell gateway URL must be an HTTP(S) URL without credentials, query, or fragment',
  ),
);

const configuration = Config.all({
  apiKey: Config.redacted('ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY'),
  baseUrl: Config.schema(httpUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
});

type GatewayContextIssue = (
  payload: {
    readonly audience: 'commerce-fx';
    readonly legalEntityId: string;
  },
  options: ApiKeyGatewayContextClientOptions,
) => Effect.Effect<GatewayContextResponse, GatewayContextClientError>;

const issueGatewayContextOverFetch: GatewayContextIssue = issueApiKeyGatewayContext;

const unavailable = (cause: unknown) => {
  const failure = PurchaseLimitFxUnavailableSchema.make({
    code: 'purchase_limit_fx_unavailable',
    reason: 'The server-owned Commerce FX credential could not be issued',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

export const makeCommerceFxGatewayCredentialIssuer = (
  configured: {
    readonly apiKey: Redacted.Redacted;
    readonly baseUrl: URL;
  },
  issue: GatewayContextIssue = issueGatewayContextOverFetch,
): CommerceFxGatewayCredentialIssuer =>
  Object.freeze({
    issue: Effect.fn('CommerceFxGatewayCredentialIssuer.issue')(
      function* issueCommerceFxGatewayCredential(input: CommerceFxGatewayCredentialRequest) {
        const gatewayOptions: ApiKeyGatewayContextClientOptions = {
          apiKey: configured.apiKey,
          baseUrl: configured.baseUrl,
          requestCorrelation: input.requestCorrelation,
        };
        const response = yield* issue(
          { audience: input.audience, legalEntityId: input.legalEntityId },
          gatewayOptions,
        ).pipe(Effect.mapError(unavailable));
        return Redacted.make(`Bearer ${response.token}`);
      },
    ),
  });

/**
 * Deployment-owned server credential. Shell binds the API key to the same system Principal used by
 * the Commerce FX Purchase Limit exact-disclosure grant; invalid configuration stays fail-closed.
 */
export const makeCommerceFxGatewayCredentialLayer = (
  issue: GatewayContextIssue = issueGatewayContextOverFetch,
) =>
  Layer.effect(
    CommerceFxGatewayCredentialService,
    configuration.pipe(
      Effect.match({
        onFailure: (configurationError) => ({
          issue: () => Effect.fail(unavailable(configurationError)),
        }),
        onSuccess: (configured) => makeCommerceFxGatewayCredentialIssuer(configured, issue),
      }),
    ),
  );

export const commerceFxGatewayCredentialLive = makeCommerceFxGatewayCredentialLayer();
