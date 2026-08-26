// @effect-diagnostics asyncFunction:off cryptoRandomUUIDInEffect:off
import {
  GATEWAY_ASSERTION_TTL_SECONDS,
  GATEWAY_ASSERTION_VERSION,
  GatewayTrustedPrincipalContextSchema,
} from '@app/shared-contracts';
import type { GatewayContextResponse, GatewayTrustedPrincipalContext } from '@app/shared-contracts';
import { Clock, Effect, Schema } from 'effect';
import { SignJWT, importJWK } from 'jose';
import type { InstalledVerticalTopologyError } from '../verticals/installed-verticals.ts';
import { loadGatewayIssuerConfig } from './gateway-issuer-config.ts';
import type {
  GatewayIssuerConfigError,
  GatewayIssuerConfigValue,
} from './gateway-issuer-config.ts';

export class GatewayIssuerError extends Schema.TaggedError<GatewayIssuerError>()(
  'GatewayIssuerError',
  {
    code: Schema.Literals(['gateway_audience_invalid', 'gateway_issuer_unavailable']),
    reason: Schema.String,
  },
) {}

export interface IssueGatewayAssertionInput<Principal = GatewayTrustedPrincipalContext> {
  readonly audience: string;
  readonly principal: Principal;
}

export interface GatewayIssuerDependencies {
  readonly currentTimeSeconds: Effect.Effect<number>;
  readonly generateJti: Effect.Effect<string>;
  readonly loadAudiences: Effect.Effect<
    ReadonlySet<string>,
    InstalledVerticalTopologyError | GatewayIssuerError
  >;
  readonly loadConfig: Effect.Effect<GatewayIssuerConfigValue, GatewayIssuerConfigError>;
}

export const gatewayIssuerLiveDependencies: GatewayIssuerDependencies = {
  currentTimeSeconds: Clock.currentTimeMillis.pipe(
    Effect.map((milliseconds) => Math.floor(milliseconds / 1000)),
  ),
  generateJti: Effect.sync(() => globalThis.crypto.randomUUID()),
  loadAudiences: Effect.tryPromise({
    catch: () =>
      new GatewayIssuerError({
        code: 'gateway_issuer_unavailable',
        reason: 'The generated MicroVertical audience topology is unavailable',
      }),
    try: () => import('../verticals/installed-verticals.ts'),
  }).pipe(Effect.flatMap((module) => module.installedVerticalIds)),
  loadConfig: loadGatewayIssuerConfig(),
};

const unavailable = () =>
  new GatewayIssuerError({
    code: 'gateway_issuer_unavailable',
    reason: 'The gateway assertion issuer is unavailable',
  });

export const issueGatewayContextAssertion = <Principal>(
  input: IssueGatewayAssertionInput<Principal>,
  dependencies: GatewayIssuerDependencies = gatewayIssuerLiveDependencies,
): Effect.Effect<GatewayContextResponse, GatewayIssuerError> =>
  Effect.gen(function* issueGatewayContextAssertionEffect() {
    const principal = yield* Schema.decodeUnknownEffect(GatewayTrustedPrincipalContextSchema, {
      onExcessProperty: 'error',
    })(input.principal).pipe(Effect.mapError(unavailable));
    const audiences = yield* dependencies.loadAudiences.pipe(Effect.mapError(unavailable));
    if (!audiences.has(input.audience)) {
      return yield* new GatewayIssuerError({
        code: 'gateway_audience_invalid',
        reason: 'The requested gateway audience is not a generated MicroVertical',
      });
    }

    const configuration = yield* dependencies.loadConfig.pipe(Effect.mapError(unavailable));
    const issuedAt = yield* dependencies.currentTimeSeconds;
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
      return yield* unavailable();
    }
    const expiresAt = issuedAt + GATEWAY_ASSERTION_TTL_SECONDS;
    const jti = yield* dependencies.generateJti;

    const token = yield* Effect.tryPromise({
      catch: unavailable,
      try: async () => {
        const key = await importJWK(configuration.privateJwk, 'EdDSA');
        return new SignJWT({
          principal,
          ver: GATEWAY_ASSERTION_VERSION,
        })
          .setProtectedHeader({
            alg: 'EdDSA',
            kid: configuration.privateJwk.kid,
            typ: 'JWT',
          })
          .setIssuer(configuration.issuer)
          .setAudience(input.audience)
          .setSubject(principal.principalId)
          .setIssuedAt(issuedAt)
          .setExpirationTime(expiresAt)
          .setJti(jti)
          .sign(key);
      },
    });

    return { expiresAt, token };
  });
