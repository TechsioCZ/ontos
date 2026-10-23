import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import {
  ActiveApplicationCompositionService,
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
} from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { PgClient } from '@effect/sql-pg';
import { ConfigProvider, Context, Effect, Layer, Redacted, Schema } from 'effect';
import { GatewayPrincipalVerifierLive } from '@app/gateway-principal-verifier/server';
import { expect, it } from 'effect-rstest';

import { testDatabaseClients } from '../../../../packages/core-runtime/tests/support/database.ts';
import { ActionPrincipalScopeErrorSchema, verifyActionPrincipal } from '../../api/auth/action-principal.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { GatewayAssertionRedemptionLive } from '../../src/auth/gateway-assertion-redemption-runtime.ts';

const withRedemption = Effect.gen(function* acquirePrivacyRedemption() {
  const { admin, runtime } = yield* testDatabaseClients;
  const services = yield* Layer.build(
    GatewayAssertionRedemptionLive.pipe(Layer.provide(Layer.succeed(PgClient.PgClient, runtime))),
  );
  const redemption = Context.get(services, GatewayAssertionRedemptionService);
  const issuer = `https://privacy-redemption.ontos.test/${randomUUID()}`;
  const [epoch] = yield* admin.unsafe('select floor(extract(epoch from clock_timestamp()))::text as now');
  const { now } = yield* Schema.decodeUnknownEffect(Schema.Struct({ now: Schema.FiniteFromString }))(epoch);
  const assertion = { audience: 'privacy', expiresAtEpochSeconds: now + 300, issuer, jti: randomUUID() };
  yield* Effect.addFinalizer(() =>
    admin.unsafe('delete from privacy.gateway_assertion_redemptions where issuer = $1', [issuer]).pipe(Effect.orDie),
  );
  return { admin, assertion, now, redemption };
});

it.live('accepts a first assertion before business scope is installed', () =>
  Effect.scoped(
    Effect.gen(function* acceptFirstAssertion() {
      const { admin, assertion, redemption } = yield* withRedemption;
      yield* redemption.consume(assertion);
      const rows = yield* admin.unsafe(
        'select issuer, audience, jti from privacy.gateway_assertion_redemptions where issuer = $1',
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
      const snapshot = yield* makeApplicationCompositionSnapshotFixture(['privacy'], ultramodernApiMarker.buildMarker);
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const principalId = randomUUID();
      const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'privacy-test', typ: 'JWT' })).toString(
        'base64url',
      );
      const payload = Buffer.from(
        JSON.stringify({
          aud: 'crm',
          compositionRevision: snapshot.composition.revision,
          exp: assertion.expiresAtEpochSeconds,
          iat: now,
          iss: assertion.issuer,
          jti: assertion.jti,
          principal: {
            authBindingId: randomUUID(),
            authContextRef: 'privacy-redemption-test',
            authMethod: 'session',
            principalId,
            tenantId: randomUUID(),
          },
          sub: principalId,
          targetBuildMarker: ultramodernApiMarker.buildMarker,
          ver: GATEWAY_ASSERTION_VERSION,
        }),
      ).toString('base64url');
      const signed = `${header}.${payload}`;
      const token = `${signed}.${sign(null, Buffer.from(signed), privateKey).toString('base64url')}`;
      const environment = {
        ONTOS_GATEWAY_ISSUER: assertion.issuer,
        ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
          keys: [{ ...publicKey.export({ format: 'jwk' }), alg: 'EdDSA', kid: 'privacy-test', use: 'sig' }],
        }),
      };
      const verification = (bearer: string) =>
        verifyActionPrincipal(Redacted.make(`Bearer ${bearer}`), { environment, redemption }).pipe(
          Effect.provide(GatewayPrincipalVerifierLive),
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
          Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
        );
      const failure = yield* verification(token).pipe(Effect.flip);
      expect(Schema.is(ActionPrincipalScopeErrorSchema)(failure)).toBe(true);
      expect(
        yield* admin.unsafe('select jti from privacy.gateway_assertion_redemptions where issuer = $1', [
          assertion.issuer,
        ]),
      ).toEqual([]);
      // A valid audience using the same identity still succeeds through Privacy's actual verifier and store.
      const validPayload = Buffer.from(
        JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), aud: 'privacy' }),
      ).toString('base64url');
      const validSigned = `${header}.${validPayload}`;
      yield* verification(`${validSigned}.${sign(null, Buffer.from(validSigned), privateKey).toString('base64url')}`);
    }),
  ),
);
