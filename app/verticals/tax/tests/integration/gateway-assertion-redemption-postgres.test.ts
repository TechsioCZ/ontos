import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import {
  ActiveApplicationCompositionService,
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
} from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Layer, Redacted, Schema } from 'effect';
import { ActionPrincipalScopeErrorSchema, bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { expect, it } from 'effect-rstest';

import { testDatabaseClients } from '../../../../packages/core-runtime/tests/support/database.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { GatewayAssertionRedemptionLive } from '../../src/auth/gateway-assertion-redemption-runtime.ts';

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const withRedemption = Effect.gen(function* acquireTaxRedemption() {
  const { admin, runtime } = yield* testDatabaseClients;
  const services = yield* Layer.build(
    GatewayAssertionRedemptionLive.pipe(Layer.provide(Layer.succeed(PgClient.PgClient, runtime))),
  );
  const redemption = Context.get(services, GatewayAssertionRedemptionService);
  const issuer = `https://tax-redemption.ontos.test/${randomUUID()}`;
  const [epoch] = yield* admin.unsafe('select floor(extract(epoch from clock_timestamp()))::text as now');
  const { now } = yield* Schema.decodeUnknownEffect(Schema.Struct({ now: Schema.FiniteFromString }))(epoch);
  const assertion = { audience: 'tax', expiresAtEpochSeconds: now + 300, issuer, jti: randomUUID() };
  yield* Effect.addFinalizer(() =>
    admin.unsafe('delete from tax.gateway_assertion_redemptions where issuer = $1', [issuer]).pipe(Effect.orDie),
  );
  return { admin, assertion, now, redemption };
});

it.live('accepts a first assertion before business scope is installed', () =>
  Effect.scoped(
    Effect.gen(function* acceptFirstAssertion() {
      const { admin, assertion, redemption } = yield* withRedemption;
      yield* redemption.consume(assertion);
      const [grant] = yield* admin.unsafe(
        `select has_table_privilege('ontos_runtime', 'tax.gateway_assertion_redemptions', 'SELECT') as can_select,
                has_table_privilege('ontos_runtime', 'tax.gateway_assertion_redemptions', 'INSERT') as can_insert,
                has_table_privilege('ontos_runtime', 'tax.gateway_assertion_redemptions', 'DELETE') as can_delete,
                has_table_privilege('ontos_runtime', 'tax.gateway_assertion_redemptions', 'UPDATE') as can_update`,
      );
      expect(grant).toEqual({ can_delete: true, can_insert: true, can_select: true, can_update: false });
      const rows = yield* admin.unsafe(
        'select issuer, audience, jti from tax.gateway_assertion_redemptions where issuer = $1',
        [assertion.issuer],
      );
      expect(rows).toEqual([{ audience: assertion.audience, issuer: assertion.issuer, jti: assertion.jti }]);
    }),
  ),
);

it.live('durably rejects replay across independently acquired redemption services', () =>
  Effect.scoped(
    Effect.gen(function* rejectDurableReplay() {
      const { assertion, redemption } = yield* withRedemption;
      const independent = yield* withRedemption;
      yield* redemption.consume(assertion);
      const failure = yield* independent.redemption.consume(assertion).pipe(Effect.flip);
      expect(Schema.is(GatewayAssertionReplayError)(failure)).toBe(true);
    }),
  ),
);

it.live('rejects a correctly signed wrong-audience assertion without redeeming it', () =>
  Effect.scoped(
    Effect.gen(function* rejectWrongAudience() {
      const { admin, assertion, now, redemption } = yield* withRedemption;
      const snapshot = yield* makeApplicationCompositionSnapshotFixture(['tax'], ultramodernApiMarker.buildMarker);
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const principalId = randomUUID();
      const header = Buffer.from(yield* encodeJson({ alg: 'EdDSA', kid: 'tax-test', typ: 'JWT' })).toString(
        'base64url',
      );
      const claims = {
        aud: 'crm',
        compositionRevision: snapshot.composition.revision,
        exp: assertion.expiresAtEpochSeconds,
        iat: now,
        iss: assertion.issuer,
        jti: assertion.jti,
        principal: {
          authBindingId: randomUUID(),
          authContextRef: 'tax-redemption-test',
          authMethod: 'session',
          principalId,
          tenantId: randomUUID(),
        },
        sub: principalId,
        targetBuildMarker: ultramodernApiMarker.buildMarker,
        ver: GATEWAY_ASSERTION_VERSION,
      };
      const payload = Buffer.from(yield* encodeJson(claims)).toString('base64url');
      const signed = `${header}.${payload}`;
      const token = `${signed}.${sign(null, Buffer.from(signed), privateKey).toString('base64url')}`;
      const environment = {
        ONTOS_GATEWAY_ISSUER: assertion.issuer,
        ONTOS_GATEWAY_PUBLIC_JWKS: yield* encodeJson({
          keys: [{ ...publicKey.export({ format: 'jwk' }), alg: 'EdDSA', kid: 'tax-test', use: 'sig' }],
        }),
      };
      const verification = (bearer: string) =>
        bindGatewayPrincipalVerifier('tax', ultramodernApiMarker)
          .verifyAndRedeem(Redacted.make(`Bearer ${bearer}`), { environment, redemption })
          .pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }));
      const failure = yield* verification(token).pipe(Effect.flip);
      expect(Schema.is(ActionPrincipalScopeErrorSchema)(failure)).toBe(true);
      expect(
        yield* admin.unsafe('select jti from tax.gateway_assertion_redemptions where issuer = $1', [assertion.issuer]),
      ).toEqual([]);
      // A valid audience using the same identity still succeeds through Tax's actual verifier and store.
      const validPayload = Buffer.from(yield* encodeJson({ ...claims, aud: 'tax' })).toString('base64url');
      const validSigned = `${header}.${validPayload}`;
      yield* verification(`${validSigned}.${sign(null, Buffer.from(validSigned), privateKey).toString('base64url')}`);
    }),
  ),
);
