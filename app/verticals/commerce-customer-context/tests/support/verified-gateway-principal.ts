import { randomUUID } from 'node:crypto';

import { ActiveApplicationCompositionService, GatewayAssertionRedemptionService } from '@app/core-runtime';
import type { ActiveApplicationCompositionSnapshot, TrustedPrincipalContext } from '@app/core-runtime';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION, GATEWAY_ASSERTION_TTL_SECONDS } from '@app/shared-contracts';
import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { SqlClient } from 'effect/sql';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../api/auth/gateway-assertion-redemption.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

const audience = 'commerce-customer-context';
const issuer = 'https://verified-gateway-principal-test.invalid';
const keyId = 'verified-gateway-principal-test';
const DatabaseEpochSchema = Schema.Struct({ epoch: Schema.Int });

/**
 * Redeems a TEST-issuer Gateway assertion for each actor, as the Shell-fronted owner receives it. Only a
 * redeemed principal carries the verified scope a delegated module-to-module call acts for.
 */
export const makeVerifiedGatewayPrincipals = Effect.fn('VerifiedGatewayPrincipal.make')(function* make(input: {
  readonly runtimeConnectionString: string;
  readonly snapshot: ActiveApplicationCompositionSnapshot;
}) {
  const runtimeContext = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(input.runtimeConnectionString) }).pipe(Layer.provideMerge(Reactivity.layer)),
  );
  const redemption = Context.get(
    yield* Layer.build(
      GatewayAssertionRedemptionLive.pipe(
        Layer.provide(GatewayAssertionRedemptionDatabaseLive),
        Layer.provide(Layer.succeedContext(runtimeContext)),
      ),
    ),
    GatewayAssertionRedemptionService,
  );
  const client = Context.get(runtimeContext, SqlClient.SqlClient);
  const pair = yield* Effect.promise(async () => await generateKeyPair('EdDSA'));
  const jwk = yield* Effect.promise(async () => await exportJWK(pair.publicKey));
  const verifier = bindGatewayPrincipalVerifier(audience, ultramodernApiMarker);
  return Effect.fn('VerifiedGatewayPrincipal.redeem')(function* redeem(actor: TrustedPrincipalContext) {
    // The database clock decides redemption, so the assertion is issued on that clock.
    const [clock] = yield* client<{
      readonly epoch: number;
    }>`select floor(extract(epoch from clock_timestamp()))::integer as epoch`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DatabaseEpochSchema))),
      Effect.orDie,
    );
    if (clock === undefined) {
      return yield* Effect.die('The database clock is unavailable');
    }
    const token = yield* Effect.promise(
      async () =>
        await new SignJWT({
          compositionRevision: input.snapshot.composition.revision,
          principal: actor,
          targetBuildMarker: ultramodernApiMarker.buildMarker,
          ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
        })
          .setProtectedHeader({ alg: 'EdDSA', kid: keyId, typ: 'JWT' })
          .setIssuer(issuer)
          .setAudience(audience)
          .setSubject(actor.principalId)
          .setIssuedAt(clock.epoch)
          .setExpirationTime(clock.epoch + GATEWAY_ASSERTION_TTL_SECONDS)
          .setJti(randomUUID())
          .sign(pair.privateKey),
    );
    return yield* verifier
      .verifyAndRedeem(Redacted.make(`Bearer ${token}`), {
        environment: {
          ONTOS_GATEWAY_ISSUER: issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...jwk, alg: 'EdDSA', kid: keyId, use: 'sig' }] }),
        },
        redemption,
      })
      .pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(input.snapshot) }));
  });
});
