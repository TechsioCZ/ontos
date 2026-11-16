import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Exit, Layer } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  actionInvocations,
  coreRelations,
  legalEntities,
  principals,
  sourceExecutionFences,
  tenants,
} from '../../src/db/schema.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../src/testing/isolated-native-database.ts';
import { cancelOwnedSyncAdmissionFenceNative } from '../../src/testing/source-execution-fence-native.ts';
import type { OwnedSyncAdmissionFenceFaultInput } from '../../src/testing/source-execution-fence-native.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import {
  freshOutboxWorkerCompositionSnapshot,
  makeOutboxWorkerComposition,
} from '../support/outbox-worker-composition.ts';

interface AdmissionFact {
  readonly actionKey: string;
  readonly legalEntityId: string | null;
  readonly principalId: string;
  readonly status: 'running' | 'succeeded';
}

const nativeServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.layer(nativeServices, { excludeTestServices: true })('Owned Sync cancellation TEST fault', (suite) => {
  suite.effect(
    'cancels only exact succeeded Integration Sync facts and refuses foreign, forged, stale and closed controls',
    () =>
      Effect.gen(function* ownedSyncCancellationFault() {
        const closedInput = yield* Effect.scoped(
          Effect.gen(function* liveOwnedSyncFault() {
            const snapshot = yield* freshOutboxWorkerCompositionSnapshot(
              makeOutboxWorkerComposition([
                { appId: 'owned-sync-fault', buildMarker: 'owned-sync-fault', moduleId: 'core.shell' },
              ]),
            );
            const ownedDatabase = yield* makeIsolatedNativeDatabaseFixture({
              compositionSnapshot: snapshot,
              mode: 'schema-only',
              purpose: 'implementation-1096-registered-workload-gateway',
            });
            const client = yield* makeTestPgClient(ownedDatabase.connections.admin.connectionString);
            const database = yield* makeTestDatabaseFromClient(client, coreRelations);
            const crypto = yield* Crypto.Crypto;
            const tenantId = yield* crypto.randomUUIDv4();
            const integrationId = yield* crypto.randomUUIDv4();
            const humanId = yield* crypto.randomUUIDv4();
            const legalEntityId = yield* crypto.randomUUIDv4();
            const now = DateTime.toDateUtc(yield* DateTime.now);
            yield* database.insert(tenants).values({
              defaultLocale: 'cs',
              name: 'Owned Sync fault test',
              slug: `sync-fault-${tenantId}`,
              status: 'active',
              tenantId,
            });
            yield* database.insert(principals).values([
              {
                displayName: 'Internal Integration',
                kind: 'integration',
                principalId: integrationId,
                status: 'active',
                tenantId,
              },
              { displayName: 'Internal Human', kind: 'human', principalId: humanId, status: 'active', tenantId },
            ]);
            yield* database.insert(legalEntities).values({
              legalEntityId,
              legalName: 'Internal company',
              registrationCountry: 'CZ',
              registrationNumber: 'INTERNAL_SYNC_FAULT',
              status: 'active',
              tenantId,
            });
            // Native Core fact fixtures test the helper. The application conformance test supplies actual admitted Sync facts.
            const seedAdmission = Effect.fn('OwnedSyncFault.seedCoreFacts')(function* seedCoreFacts(
              fact: AdmissionFact,
            ) {
              const admissionId = yield* crypto.randomUUIDv4();
              yield* database.insert(actionInvocations).values({
                actionInvocationId: admissionId,
                actionKey: fact.actionKey,
                authMethod: 'api_key',
                completedAt: fact.status === 'succeeded' ? now : null,
                legalEntityId: fact.legalEntityId,
                principalId: fact.principalId,
                requestHash: 'a'.repeat(64),
                status: fact.status,
                tenantId,
              });
              yield* database
                .insert(sourceExecutionFences)
                .values({ admissionInvocationId: admissionId, state: 'open', tenantId });
              return admissionId;
            });
            const actionKey = 'integration.symmy.admit-symmy-sync';
            const admissionId = yield* seedAdmission({
              actionKey,
              legalEntityId: null,
              principalId: integrationId,
              status: 'succeeded',
            });
            const input: OwnedSyncAdmissionFenceFaultInput = {
              admissionId,
              expectedLegalEntityId: null,
              expectedOriginalIntegrationPrincipalId: integrationId,
              ownedDatabase,
              purpose: 'implementation-1096-registered-workload-gateway',
              tenantId,
            };
            const running = yield* seedAdmission({
              actionKey,
              legalEntityId: null,
              principalId: integrationId,
              status: 'running',
            });
            const otherAction = yield* seedAdmission({
              actionKey: 'integration.symmy.admit-symmy-job',
              legalEntityId: null,
              principalId: integrationId,
              status: 'succeeded',
            });
            const humanAction = yield* seedAdmission({
              actionKey,
              legalEntityId: null,
              principalId: humanId,
              status: 'succeeded',
            });
            const invalid = [
              { ...input, admissionId: 'invalid-uuid' },
              { ...input, tenantId: yield* crypto.randomUUIDv4() },
              { ...input, expectedOriginalIntegrationPrincipalId: humanId },
              { ...input, admissionId: yield* crypto.randomUUIDv4() },
              { ...input, expectedLegalEntityId: legalEntityId },
              { ...input, admissionId: running },
              { ...input, admissionId: otherAction },
              { ...input, admissionId: humanAction, expectedOriginalIntegrationPrincipalId: humanId },
              { ...input, ownedDatabase: { ...ownedDatabase } },
            ];
            for (const refused of invalid) {
              expect(Exit.isFailure(yield* cancelOwnedSyncAdmissionFenceNative(refused).pipe(Effect.exit))).toBe(true);
            }
            const wrongPurpose = yield* makeIsolatedNativeDatabaseFixture({
              mode: 'empty',
              purpose: 'implementation-1118-symmy-job-admission',
            });
            expect(
              Exit.isFailure(
                yield* cancelOwnedSyncAdmissionFenceNative({ ...input, ownedDatabase: wrongPurpose }).pipe(Effect.exit),
              ),
            ).toBe(true);
            expect(
              yield* database
                .select({ state: sourceExecutionFences.state })
                .from(sourceExecutionFences)
                .where(
                  and(
                    eq(sourceExecutionFences.tenantId, tenantId),
                    eq(sourceExecutionFences.admissionInvocationId, admissionId),
                  ),
                ),
            ).toEqual([{ state: 'open' }]);
            yield* cancelOwnedSyncAdmissionFenceNative(input);
            expect(
              yield* database
                .select({ state: sourceExecutionFences.state })
                .from(sourceExecutionFences)
                .where(
                  and(
                    eq(sourceExecutionFences.tenantId, tenantId),
                    eq(sourceExecutionFences.admissionInvocationId, admissionId),
                  ),
                ),
            ).toEqual([{ state: 'cancelled' }]);
            expect(Exit.isFailure(yield* cancelOwnedSyncAdmissionFenceNative(input).pipe(Effect.exit))).toBe(true);
            const companyAdmission = yield* seedAdmission({
              actionKey,
              legalEntityId,
              principalId: integrationId,
              status: 'succeeded',
            });
            expect(
              Exit.isFailure(
                yield* cancelOwnedSyncAdmissionFenceNative({ ...input, admissionId: companyAdmission }).pipe(
                  Effect.exit,
                ),
              ),
            ).toBe(true);
            yield* cancelOwnedSyncAdmissionFenceNative({
              ...input,
              admissionId: companyAdmission,
              expectedLegalEntityId: legalEntityId,
            });
            return input;
          }),
        );
        expect(Exit.isFailure(yield* cancelOwnedSyncAdmissionFenceNative(closedInput).pipe(Effect.exit))).toBe(true);
      }),
    30_000,
  );
});
