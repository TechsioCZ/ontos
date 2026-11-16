import { Cache, Context, Effect, Exit, Layer } from 'effect';
import { createLocalJWKSet } from 'jose';
import type { LocalJWKSet } from 'jose';

import { delegationUnavailable } from './gateway-delegation-errors.ts';
import { loadGatewayIssuerConfig } from './gateway-issuer-config.ts';
import type { GatewayIssuerConfigError, GatewayIssuerConfigValue } from './gateway-issuer-config.ts';

export class GatewayDelegationVerification extends Context.Service<
  GatewayDelegationVerification,
  {
    readonly load: Effect.Effect<
      { readonly issuer: string; readonly keys: LocalJWKSet },
      ReturnType<ReturnType<typeof delegationUnavailable>>
    >;
  }
>()('@app/shell-super-app/api/auth/gateway-delegation-verification/GatewayDelegationVerification') {}

/**
 * The key a delegated request's source assertion is verified with. The Shell signed that assertion itself, so it
 * verifies it with the public half of its own signing key and its own issuer: the same configuration it signs with,
 * never a second copy of the public key that could be missing or name another key.
 */
export const delegationVerificationOf = ({ issuer, privateJwk }: GatewayIssuerConfigValue) => ({
  issuer,
  keys: createLocalJWKSet({
    keys: [
      {
        alg: privateJwk.alg,
        crv: privateJwk.crv,
        key_ops: ['verify'],
        kid: privateJwk.kid,
        kty: privateJwk.kty,
        use: privateJwk.use,
        x: privateJwk.x,
      },
    ],
  }),
});

/**
 * The verification for the signing configuration `loadConfig` reads. Lazy like the signer: absent signing configuration
 * never blocks unrelated authentication.
 */
export const makeGatewayDelegationVerificationLayer = (
  loadConfig: Effect.Effect<GatewayIssuerConfigValue, GatewayIssuerConfigError>,
) =>
  Layer.effect(
    GatewayDelegationVerification,
    Effect.gen(function* prepareDelegationVerification() {
      const cache = yield* Cache.makeWith(
        (_key: 'current') =>
          loadConfig.pipe(
            Effect.mapError(delegationUnavailable('verification_keys_unavailable')),
            Effect.map(delegationVerificationOf),
          ),
        { capacity: 1, timeToLive: (exit) => (Exit.isSuccess(exit) ? '30 seconds' : '0 seconds') },
      );
      return { load: Cache.get(cache, 'current') };
    }),
  );

/** Verifies with the signing configuration the Shell's own issuer loads. */
export const GatewayDelegationVerificationLive = makeGatewayDelegationVerificationLayer(loadGatewayIssuerConfig());
