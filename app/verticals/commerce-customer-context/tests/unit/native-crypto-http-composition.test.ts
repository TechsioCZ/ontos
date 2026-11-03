import { randomUUID } from 'node:crypto';

import {
  ActionRuntime,
  ContextAccess,
  DatabaseConfig,
  GatewayAssertionRedemptionService,
  ReadRuntime,
} from '@app/core-runtime';
import type { ActionRuntimeService, ReadRuntimeService } from '@app/core-runtime';
import { ActiveApplicationCompositionSnapshotSchema } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSource } from '@app/core-runtime/testing/application-composition-source';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { ConfigProvider, Crypto, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { makeCommerceCustomerContextApiRuntime } from '../../api/index.ts';
import { commercePortalAuthRealmUnavailableLive } from '../../api/portal-auth/realm-unavailable.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

const origin = 'http://localhost:3020';
const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const unusedContextAccess = () => Effect.die('unused context authorization');

/** HTTP composition only: no business runtime, SQL query or production authorization is simulated as success. */
it.live('provides host Crypto to a deferred business Read without a portal realm', () =>
  Effect.scoped(
    Effect.gen(function* verifyDeferredReadCrypto() {
      const snapshot = yield* makeApplicationCompositionSnapshotFixture(
        ['commerce-customer-context'],
        ultramodernApiMarker.buildMarker,
      );
      const document = yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
        snapshot,
      );
      const issuer = 'https://shell.ccc-crypto-composition.test';
      const { privateKey, publicKey } = yield* Effect.promise(async () => await generateKeyPair('Ed25519'));
      const publicJwk = {
        ...(yield* Effect.promise(async () => await exportJWK(publicKey))),
        alg: 'EdDSA',
        kid: 'ccc-native-crypto-composition',
        use: 'sig',
      };
      const token = yield* Effect.promise(
        async () =>
          await new SignJWT({
            compositionRevision: snapshot.composition.revision,
            principal: {
              authBindingId: '66666666-6666-4666-8666-666666666666',
              authContextRef: 'better-auth-session:ccc-crypto-composition',
              authMethod: 'session',
              principalId,
              tenantId,
            },
            targetBuildMarker: ultramodernApiMarker.buildMarker,
            ver: 1,
          })
            .setProtectedHeader({ alg: 'EdDSA', kid: publicJwk.kid, typ: 'JWT' })
            .setIssuer(issuer)
            .setAudience('commerce-customer-context')
            .setSubject(principalId)
            .setIssuedAt()
            .setExpirationTime('5m')
            .setJti(randomUUID())
            .sign(privateKey),
      );
      let readCalls = 0;
      const readRuntime: ReadRuntimeService = {
        runRead: () =>
          Effect.gen(function* executeDeferredBusinessRead() {
            const crypto = yield* Effect.serviceOption(Crypto.Crypto);
            if (Option.isNone(crypto)) {
              return yield* Effect.die('HTTP execution context has no native Crypto');
            }
            const generatedId = yield* crypto.value.randomUUIDv4().pipe(Effect.orDie);
            expect(Schema.is(Schema.String.check(Schema.isUUID(4)))(generatedId)).toBe(true);
            readCalls += 1;
            return yield* Effect.die('stopped after deferred native Crypto proof');
          }),
      };
      const actionRuntime: ActionRuntimeService = {
        resolveActionCommit: () => Effect.die('unused Action commit'),
        runAction: () => Effect.die('unused Action'),
      };
      const configuration = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ONTOS_GATEWAY_ISSUER: issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            keys: [publicJwk],
          }),
        }),
      );
      const assembled = makeCommerceCustomerContextApiRuntime(
        Layer.succeed(ReadRuntime, readRuntime),
        Layer.mergeAll(
          Layer.succeed(ActionRuntime, actionRuntime),
          Layer.succeed(ActiveApplicationCompositionSource, { load: Effect.succeed(document) }),
          configuration,
        ),
        Layer.succeed(GatewayAssertionRedemptionService, { consume: () => Effect.void }),
        commercePortalAuthRealmUnavailableLive([origin]),
        configuration,
        // Unused enrollment pools are lazy (SDK minConnections=0); no business SQL is invoked.
        Layer.succeed(DatabaseConfig, {
          connectionString: 'postgresql://ontos_runtime:unit-only@127.0.0.1:1/unused',
          database: 'unused',
          host: '127.0.0.1',
          port: 1,
          user: 'ontos_runtime',
        }),
        Layer.succeed(ContextAccess, {
          legalEntities: unusedContextAccess,
          modules: unusedContextAccess,
          resources: unusedContextAccess,
          tenants: unusedContextAccess,
        }),
      );
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() => assembled.createHandler()),
        (resource) => Effect.promise(async () => await resource.dispose()).pipe(Effect.orDie),
      );
      const response = yield* Effect.promise(
        async () =>
          await runtime.handler(
            new Request(`${origin}/reads/saved-address-list`, {
              body: JSON.stringify({
                profile: {
                  kind: 'RETAIL',
                  profileRef: {
                    moduleId: 'commerce.customer-context',
                    resourceId: '44444444-4444-4444-8444-444444444444',
                    resourceType: 'commerce.customer-context.retail-customer-profile',
                    tenantId,
                  },
                },
              }),
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                'x-correlation-id': 'ccc-native-crypto-composition',
              },
              method: 'POST',
            }),
          ),
      );
      expect(response.status).toBe(500);
      expect(readCalls).toBe(1);
    }),
  ),
);
