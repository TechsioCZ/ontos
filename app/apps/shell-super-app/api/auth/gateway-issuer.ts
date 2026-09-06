// @effect-diagnostics asyncFunction:off cryptoRandomUUIDInEffect:off
import {
  GATEWAY_ASSERTION_TTL_SECONDS,
  GATEWAY_ASSERTION_VERSION,
  GatewayTrustedPrincipalContextSchema,
} from '@app/shared-contracts';
import type { GatewayContextResponse, GatewayTrustedPrincipalContext } from '@app/shared-contracts';
import { createHash } from 'node:crypto';
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
    stage: Schema.Literals(['audience', 'clock', 'configuration', 'principal', 'signing']),
  },
) {}

export interface IssueGatewayAssertionInput<Principal = GatewayTrustedPrincipalContext> {
  readonly audience: string;
  readonly principal: Principal;
}

type GatewaySigningKey = Awaited<ReturnType<typeof importJWK>>;
type GatewaySigningKeyImporter = (
  privateJwk: GatewayIssuerConfigValue['privateJwk'],
) => Promise<GatewaySigningKey>;

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
        stage: 'audience',
      }),
    try: async () => await import('../verticals/installed-verticals.ts'),
  }).pipe(Effect.flatMap((module) => module.installedVerticalIds)),
  loadConfig: loadGatewayIssuerConfig(),
};

const unavailable = (stage: 'audience' | 'clock' | 'configuration' | 'principal' | 'signing') =>
  new GatewayIssuerError({
    code: 'gateway_issuer_unavailable',
    reason: 'The gateway assertion issuer is unavailable',
    stage,
  });

export type GatewayIssuer = <Principal>(
  input: IssueGatewayAssertionInput<Principal>,
) => Effect.Effect<GatewayContextResponse, GatewayIssuerError>;

export const makeGatewayIssuer = (
  dependencies: GatewayIssuerDependencies = gatewayIssuerLiveDependencies,
  importSigningKey: GatewaySigningKeyImporter = (privateJwk) => importJWK(privateJwk, 'EdDSA'),
): GatewayIssuer => {
  const loadConfiguration = dependencies.loadConfig.pipe(
    Effect.mapError(() => unavailable('configuration')),
  );
  let cachedSigningKey:
    | {
        readonly cacheKey: string;
        readonly effect: Effect.Effect<GatewaySigningKey, GatewayIssuerError>;
      }
    | undefined;

  const loadSigningKey = (
    privateJwk: GatewayIssuerConfigValue['privateJwk'],
  ): Effect.Effect<GatewaySigningKey, GatewayIssuerError> => {
    // A non-reversible fingerprint of the complete key material: any change, including a private
    // scalar that no longer matches `x`, invalidates the memo without retaining the scalar.
    const cacheKey = createHash('sha256')
      .update(`${privateJwk.kid}\n${privateJwk.x}\n${privateJwk.d}`)
      .digest('base64url');
    if (cachedSigningKey?.cacheKey === cacheKey) {
      return cachedSigningKey.effect;
    }

    const importPromise = Promise.resolve().then(async () => await importSigningKey(privateJwk));
    const next = {
      cacheKey,
      effect: Effect.tryPromise({
        catch: () => unavailable('signing'),
        try: () => importPromise,
      }),
    };
    cachedSigningKey = next;
    void importPromise.catch(() => {
      if (cachedSigningKey === next) {
        cachedSigningKey = undefined;
      }
    });
    return next.effect;
  };

  return <Principal>(input: IssueGatewayAssertionInput<Principal>) =>
    Effect.gen(function* issueGatewayContextAssertionEffect() {
      const principal = yield* Schema.decodeUnknownEffect(GatewayTrustedPrincipalContextSchema, {
        onExcessProperty: 'error',
      })(input.principal).pipe(Effect.mapError(() => unavailable('principal')));
      const audiences = yield* dependencies.loadAudiences.pipe(
        Effect.mapError(() => unavailable('audience')),
      );
      if (!audiences.has(input.audience)) {
        return yield* new GatewayIssuerError({
          code: 'gateway_audience_invalid',
          reason: 'The requested gateway audience is not a generated MicroVertical',
          stage: 'audience',
        });
      }

      const configuration = yield* loadConfiguration;
      const issuedAt = yield* dependencies.currentTimeSeconds;
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
        return yield* unavailable('clock');
      }
      const expiresAt = issuedAt + GATEWAY_ASSERTION_TTL_SECONDS;
      const jti = yield* dependencies.generateJti;
      const key = yield* loadSigningKey(configuration.privateJwk);

      const token = yield* Effect.tryPromise({
        catch: () => unavailable('signing'),
        try: async () =>
          await new SignJWT({
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
            .sign(key),
      });

      return { expiresAt, token };
    });
};

const liveGatewayIssuer = makeGatewayIssuer();

export const issueGatewayContextAssertion = <Principal>(
  input: IssueGatewayAssertionInput<Principal>,
  dependencies: GatewayIssuerDependencies = gatewayIssuerLiveDependencies,
): Effect.Effect<GatewayContextResponse, GatewayIssuerError> =>
  (dependencies === gatewayIssuerLiveDependencies
    ? liveGatewayIssuer
    : makeGatewayIssuer(dependencies))(input);
