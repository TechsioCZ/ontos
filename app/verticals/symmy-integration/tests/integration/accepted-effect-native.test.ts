import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/owner-evidence';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Crypto, Effect, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { SymmyPinnedJobPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import { symmyImportJobs, symmyIntegrationRelations, symmyJobEffects, symmyJobRoutes } from '../../src/db/schema.ts';
import {
  observeAcceptedEffectIdNativeFixture,
  AcceptedEffectIdNativeFixtureUnavailable,
} from '../support/accepted-effect-native.fixture.ts';
import type { AcceptedEffectIdNativeFixtureInput } from '../support/accepted-effect-native.fixture.ts';

const purpose = 'implementation-1096-registered-workload-gateway';
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const expectRefused = Effect.fn('AcceptedEffectObserverTest.expectRefused')(function* expectRefused(
  input: AcceptedEffectIdNativeFixtureInput,
) {
  const error = yield* Effect.flip(observeAcceptedEffectIdNativeFixture(input));
  expect(Schema.is(AcceptedEffectIdNativeFixtureUnavailable)(error)).toBe(true);
  expect(error.code).toBe('accepted_effect_observation_unavailable');
  return yield* Effect.void;
});

it.live(
  'observes only the uniquely stored effect ID in the live owned clone for its actual active human and scope',
  () =>
    Effect.gen(function* observerGuards() {
      const sourceConnections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const expired = yield* Effect.scoped(
        Effect.gen(function* inOwnedFixture() {
          const snapshot = yield* makeApplicationCompositionSnapshotFixture(
            ['symmy-integration'],
            'accepted-effect-observer-fixture',
          );
          const ownedDatabase = yield* makeIsolatedNativeDatabaseFixture({
            compositionSnapshot: snapshot,
            mode: 'schema-only',
            purpose,
          });
          const readerProviderUserId = yield* nextId;
          const fixture = yield* Effect.acquireRelease(
            makeLiveOperationFixture({
              adminConnectionString: Redacted.make(ownedDatabase.connections.admin.connectionString),
              authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
              compositionRevision: snapshot.composition.revision,
              moduleKeys: ['integration.symmy'],
              readerProviderSubjectId: readerProviderUserId,
              runtimeConnectionString: Redacted.make(ownedDatabase.connections.runtime.connectionString),
            }),
            (resource) => resource.close().pipe(Effect.orDie),
          );
          const admin = yield* PgClient.make({ url: Redacted.make(ownedDatabase.connections.admin.connectionString) });
          const database = yield* makeWithDefaults({ relations: symmyIntegrationRelations }).pipe(
            Effect.provideService(PgClient.PgClient, admin),
          );
          const routeId = yield* nextId;
          const jobId = yield* nextId;
          const planItems = [];
          for (const [index, effectKey] of ['counterparty-profile', 'ambiguous-key', 'ambiguous-key'].entries()) {
            const itemId = yield* nextId;
            planItems.push({
              effects: [
                {
                  effectKey,
                  itemId,
                  ref: {
                    effectId: yield* nextId,
                    mappingVersion: 'storage-observer-1',
                    occurrence: {
                      occurrenceId: `storage-occurrence-${index}`,
                      record: {
                        entityKind: 'INTERNAL_TEST',
                        issuerId: 'INTERNAL',
                        route: { integrationRouteId: routeId, tenantId: fixture.tenantId },
                        sourceNamespace: 'observer-fixture',
                        sourceRecordId: `storage-record-${index}`,
                      },
                    },
                    operation: {
                      entrypointKey: 'commerce.customer-context.create-counterparty-purchasing-profile',
                      moduleId: 'commerce.customer-context',
                      schemaVersion: '1',
                    },
                    routeRevision: 'storage-observer-1',
                  },
                },
              ],
              itemId,
              itemKey: `storage-item-${index}`,
            });
          }
          // These are owner-local storage fixtures, not Core admission or source-classification proof.
          const plan = yield* Schema.decodeUnknownEffect(SymmyPinnedJobPlanSchema)({ items: planItems });
          yield* database.insert(symmyJobRoutes).values({
            active: true,
            fixtureIds: ['STORAGE_OBSERVER'],
            legalEntityId: fixture.legalEntityId,
            mappingVersion: 'storage-observer-1',
            principalId: fixture.manager.principalId,
            routeId,
            routeKey: 'customersBatch',
            routeRevision: 'storage-observer-1',
            tenantId: fixture.tenantId,
          });
          yield* database.insert(symmyImportJobs).values({
            admissionInvocationId: yield* nextId,
            executionPlan: plan,
            fixtureId: 'STORAGE_OBSERVER',
            idempotencyDigest: 'a'.repeat(64),
            intentDigest: 'b'.repeat(64),
            jobId,
            legalEntityId: fixture.legalEntityId,
            mappingVersion: 'storage-observer-1',
            phase: 'admitted',
            principalId: fixture.manager.principalId,
            routeId,
            routeKey: 'customersBatch',
            routeRevision: 'storage-observer-1',
            tenantId: fixture.tenantId,
          });
          const effects = plan.items.flatMap((item) => item.effects);
          yield* database.insert(symmyJobEffects).values(
            effects.map((effect) => ({
              effect,
              effectId: effect.ref.effectId,
              effectKey: effect.effectKey,
              itemId: effect.itemId,
              jobId,
              state: 'planned' as const,
              tenantId: fixture.tenantId,
            })),
          );
          const input = {
            adminConnectionString: Redacted.make(ownedDatabase.connections.admin.connectionString),
            effectKey: 'counterparty-profile',
            jobId,
            legalEntityId: fixture.legalEntityId,
            operatorPrincipalId: fixture.reader.principalId,
            operatorProviderUserId: readerProviderUserId,
            ownedDatabase,
            purpose,
            tenantId: fixture.tenantId,
          } satisfies AcceptedEffectIdNativeFixtureInput;
          const result = yield* observeAcceptedEffectIdNativeFixture(input);
          expect(result).toBe(effects[0]?.ref.effectId);
          const copiedOwnership = Object.defineProperties(
            { ...ownedDatabase },
            Object.getOwnPropertyDescriptors(ownedDatabase),
          );
          yield* expectRefused({ ...input, ownedDatabase: copiedOwnership });
          yield* expectRefused({
            ...input,
            adminConnectionString: Redacted.make(sourceConnections.admin.connectionString),
          });
          yield* expectRefused({ ...input, tenantId: yield* nextId });
          yield* expectRefused({ ...input, legalEntityId: yield* nextId });
          yield* expectRefused({ ...input, operatorProviderUserId: yield* nextId });
          yield* expectRefused({ ...input, operatorPrincipalId: fixture.manager.principalId });
          yield* expectRefused({ ...input, jobId: yield* nextId });
          yield* expectRefused({ ...input, effectKey: 'missing-key' });
          yield* expectRefused({ ...input, effectKey: 'ambiguous-key' });
          return input;
        }),
      );
      yield* expectRefused(expired);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, Reactivity.layer))),
  90_000,
);
