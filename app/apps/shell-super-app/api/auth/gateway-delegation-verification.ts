import { Cache, Config, Context, Effect, Exit, Layer, Schema } from 'effect';
import { createLocalJWKSet } from 'jose';
import type { LocalJWKSet } from 'jose';

import { delegationUnavailable } from './gateway-delegation-errors.ts';

const verificationKey = Schema.Struct({
  alg: Schema.Literal('EdDSA'),
  crv: Schema.Literal('Ed25519'),
  d: Schema.optionalKey(Schema.Never),
  key_ops: Schema.optionalKey(Schema.Array(Schema.Literal('verify'))),
  kid: Schema.String,
  kty: Schema.Literal('OKP'),
  use: Schema.Literal('sig'),
  x: Schema.String,
});
const configuration = Config.all({
  issuer: Config.String('ONTOS_GATEWAY_ISSUER'),
  jwks: Config.schema(
    Schema.fromJsonString(
      Schema.Struct({
        keys: Schema.Array(verificationKey).check(Schema.isMinLength(1)),
      }),
    ),
    'ONTOS_GATEWAY_PUBLIC_JWKS',
  ),
});
export class GatewayDelegationVerification extends Context.Service<
  GatewayDelegationVerification,
  {
    readonly load: Effect.Effect<
      { readonly issuer: string; readonly keys: LocalJWKSet },
      ReturnType<typeof delegationUnavailable>
    >;
  }
>()('@app/shell-super-app/api/auth/gateway-delegation-verification/GatewayDelegationVerification') {}

/** Lazy like the existing signer: absent delegation configuration never blocks unrelated authentication. */
export const GatewayDelegationVerificationLive = Layer.effect(
  GatewayDelegationVerification,
  Effect.gen(function* prepareDelegationVerification() {
    const cache = yield* Cache.makeWith(
      (_key: 'current') =>
        configuration.pipe(
          Effect.mapError(delegationUnavailable),
          Effect.map((value) => ({
            issuer: value.issuer,
            keys: createLocalJWKSet({ keys: value.jwks.keys.map((key) => ({ ...key, key_ops: ['verify'] })) }),
          })),
        ),
      { capacity: 1, timeToLive: (exit) => (Exit.isSuccess(exit) ? '30 seconds' : '0 seconds') },
    );
    return { load: Cache.get(cache, 'current') };
  }),
);
