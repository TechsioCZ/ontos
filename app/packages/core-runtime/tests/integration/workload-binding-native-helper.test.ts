import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { and, eq, inArray, not, sql } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Exit, Layer } from 'effect';
import { expect, it } from 'effect-rstest';

import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../../src/auth/staff-authentication-namespace.ts';
import {
  accessWorkloadBindings,
  coreRelations,
  principalAuthBindings,
  principals,
  tenants,
} from '../../src/db/schema.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../src/testing/isolated-native-database.ts';
import { writeTestTenantScopes } from '../../src/testing/tenant-access.ts';
import {
  makeOwnedIntegrationPriceGroupReaderWorkloadControlNative,
  makeOwnedSystemWriterWorkloadControlNative,
} from '../../src/testing/workload-binding-native.ts';
import type {
  OwnedIntegrationPriceGroupReaderWorkloadControlInput,
  OwnedSystemWriterWorkloadControlInput,
} from '../../src/testing/workload-binding-native.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import {
  freshOutboxWorkerCompositionSnapshot,
  makeOutboxWorkerComposition,
} from '../support/outbox-worker-composition.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const groupWriter = 'commerce.customer-context.source-write';
const inventoryWriter = 'commerce.inventory.source-write';
const priceGroupReader = 'pricing.price-group-catalog.source-read';
const readWorkloads = [
  'commerce.customer-context.source-read',
  'commerce.inventory.source-read',
  'integration.symmy-poll',
  priceGroupReader,
];

it.layer(nativeServices, { excludeTestServices: true })('Owned native writer enrollment control', (suite) => {
  suite.effect(
    'controls exact System writers and the Integration Price Group reader with fresh incarnations and unchanged other enrollments',
    () =>
      Effect.gen(function* ownedWriterEnrollmentControl() {
        const expired = yield* Effect.scoped(
          Effect.gen(function* liveWriterEnrollmentControl() {
            const snapshot = yield* freshOutboxWorkerCompositionSnapshot(
              makeOutboxWorkerComposition([
                { appId: 'owned-binding-proof', buildMarker: 'owned-binding-proof', moduleId: 'core.shell' },
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
            const otherTenantId = yield* crypto.randomUUIDv4();
            const operatorPrincipalId = yield* crypto.randomUUIDv4();
            const systemPrincipalId = yield* crypto.randomUUIDv4();
            const otherSystemId = yield* crypto.randomUUIDv4();
            const integrationId = yield* crypto.randomUUIDv4();
            const operatorProviderUserId = `internal-operator-${operatorPrincipalId}`;
            yield* database.insert(tenants).values([
              { defaultLocale: 'cs', name: 'Writer control', slug: `writer-${tenantId}`, status: 'active', tenantId },
              {
                defaultLocale: 'cs',
                name: 'Other control',
                slug: `writer-${otherTenantId}`,
                status: 'active',
                tenantId: otherTenantId,
              },
            ]);
            yield* database.insert(principals).values([
              {
                displayName: 'Actual test operator',
                kind: 'human',
                principalId: operatorPrincipalId,
                status: 'active',
                tenantId,
              },
              {
                displayName: 'Actual System',
                kind: 'system',
                principalId: systemPrincipalId,
                status: 'active',
                tenantId,
              },
              {
                displayName: 'Foreign System',
                kind: 'system',
                principalId: otherSystemId,
                status: 'active',
                tenantId: otherTenantId,
              },
              {
                displayName: 'Integration control',
                kind: 'integration',
                principalId: integrationId,
                status: 'active',
                tenantId,
              },
            ]);
            yield* database.insert(principalAuthBindings).values({
              authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
              principalId: operatorPrincipalId,
              provider: 'better_auth',
              providerSubjectId: operatorProviderUserId,
              status: 'active',
              subjectType: 'user',
              tenantId,
            });
            // Core-native identity fixtures; the application suite supplies its genuine Shell issuer and System enrollments.
            for (const workloadKey of [groupWriter, inventoryWriter, ...readWorkloads]) {
              yield* database.insert(accessWorkloadBindings).values({
                bindingId: yield* crypto.randomUUIDv4(),
                incarnation: yield* crypto.randomUUIDv4(),
                principalId: systemPrincipalId,
                status: 'active',
                tenantId,
                workloadKey,
              });
            }
            for (const workloadKey of [priceGroupReader, groupWriter, 'commerce.catalog.symmy-product-read']) {
              yield* database.insert(accessWorkloadBindings).values({
                bindingId: yield* crypto.randomUUIDv4(),
                incarnation: yield* crypto.randomUUIDv4(),
                principalId: integrationId,
                status: 'active',
                tenantId,
                workloadKey,
              });
            }
            const input: OwnedSystemWriterWorkloadControlInput = {
              operatorPrincipalId,
              operatorProviderUserId,
              ownedDatabase,
              purpose: 'implementation-1096-registered-workload-gateway',
              systemPrincipalId,
              tenantId,
              workloadKey: groupWriter,
            };
            const readerInput: OwnedIntegrationPriceGroupReaderWorkloadControlInput = {
              integrationPrincipalId: integrationId,
              operatorPrincipalId,
              operatorProviderUserId,
              ownedDatabase,
              purpose: 'implementation-1096-registered-workload-gateway',
              tenantId,
            };
            const unbootstrapped = yield* makeOwnedSystemWriterWorkloadControlNative(input);
            const missingFence = yield* unbootstrapped.revoke().pipe(Effect.flip);
            expect(missingFence.stage).toBe('binding-revoke');
            expect(
              yield* database
                .select({ status: accessWorkloadBindings.status })
                .from(accessWorkloadBindings)
                .where(eq(accessWorkloadBindings.bindingId, unbootstrapped.originalBinding.bindingId)),
            ).toEqual([{ status: 'active' }]);
            const runtimeClient = yield* makeTestPgClient(ownedDatabase.connections.runtime.connectionString);
            const runtimeDatabase = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
            yield* writeTestTenantScopes(runtimeDatabase, { principalId: operatorPrincipalId, tenantId });
            const untouchedByReader = database
              .select()
              .from(accessWorkloadBindings)
              .where(
                and(
                  eq(accessWorkloadBindings.tenantId, tenantId),
                  not(
                    and(
                      eq(accessWorkloadBindings.principalId, integrationId),
                      eq(accessWorkloadBindings.workloadKey, priceGroupReader),
                    ),
                  ),
                ),
              )
              .orderBy(accessWorkloadBindings.bindingId);
            const beforeReader = yield* untouchedByReader;
            const invalidReaders = [
              { ...readerInput, integrationPrincipalId: systemPrincipalId },
              { ...readerInput, integrationPrincipalId: otherSystemId },
              { ...readerInput, operatorPrincipalId: integrationId },
              { ...readerInput, operatorProviderUserId: 'wrong-reader-provider' },
              { ...readerInput, tenantId: otherTenantId },
              { ...readerInput, ownedDatabase: { ...ownedDatabase } },
            ];
            for (const invalidReader of invalidReaders) {
              expect(
                Exit.isFailure(
                  yield* makeOwnedIntegrationPriceGroupReaderWorkloadControlNative(invalidReader).pipe(Effect.exit),
                ),
              ).toBe(true);
            }
            const forgedSystemReader = { ...input };
            Object.defineProperty(forgedSystemReader, 'workloadKey', { value: priceGroupReader });
            expect(
              Exit.isFailure(yield* makeOwnedSystemWriterWorkloadControlNative(forgedSystemReader).pipe(Effect.exit)),
            ).toBe(true);
            // A caller cannot retarget this fixed reader API by supplying an unrelated extra workload field.
            const untrustedReaderInput = { ...readerInput, workloadKey: groupWriter };
            const reader = yield* makeOwnedIntegrationPriceGroupReaderWorkloadControlNative(untrustedReaderInput);
            const oldReader = yield* database
              .select()
              .from(accessWorkloadBindings)
              .where(eq(accessWorkloadBindings.bindingId, reader.originalBinding.bindingId));
            expect(oldReader[0]?.workloadKey).toBe(priceGroupReader);
            yield* reader.revoke();
            const endedReader = yield* database
              .select()
              .from(accessWorkloadBindings)
              .where(eq(accessWorkloadBindings.bindingId, reader.originalBinding.bindingId));
            expect(endedReader[0]?.status).toBe('revoked');
            expect(endedReader[0]?.revokedAt).toBeInstanceOf(Date);
            const newReader = yield* reader.rebind();
            expect(newReader.bindingId).not.toBe(reader.originalBinding.bindingId);
            expect(newReader.incarnation).not.toBe(reader.originalBinding.incarnation);
            expect(
              yield* database
                .select()
                .from(accessWorkloadBindings)
                .where(eq(accessWorkloadBindings.bindingId, reader.originalBinding.bindingId)),
            ).toEqual(endedReader);
            const reboundReader = yield* database
              .select()
              .from(accessWorkloadBindings)
              .where(eq(accessWorkloadBindings.bindingId, newReader.bindingId));
            expect(reboundReader[0]?.status).toBe('active');
            expect(reboundReader[0]?.revokedAt).toBeNull();
            expect(yield* untouchedByReader).toEqual(beforeReader);
            const integrationRows = database
              .select()
              .from(accessWorkloadBindings)
              .where(
                and(
                  eq(accessWorkloadBindings.tenantId, tenantId),
                  eq(accessWorkloadBindings.principalId, integrationId),
                ),
              )
              .orderBy(accessWorkloadBindings.bindingId);
            const afterReader = yield* integrationRows;
            const readRows = database
              .select()
              .from(accessWorkloadBindings)
              .where(
                and(
                  eq(accessWorkloadBindings.tenantId, tenantId),
                  eq(accessWorkloadBindings.principalId, systemPrincipalId),
                  inArray(accessWorkloadBindings.workloadKey, readWorkloads),
                ),
              )
              .orderBy(accessWorkloadBindings.bindingId);
            const originalReads = yield* readRows;
            const originalInventory = yield* database
              .select()
              .from(accessWorkloadBindings)
              .where(
                and(
                  eq(accessWorkloadBindings.tenantId, tenantId),
                  eq(accessWorkloadBindings.principalId, systemPrincipalId),
                  eq(accessWorkloadBindings.workloadKey, inventoryWriter),
                ),
              );
            const refusedInputs = [
              { ...input, operatorProviderUserId: 'unknown-provider-user' },
              { ...input, operatorPrincipalId: systemPrincipalId },
              { ...input, systemPrincipalId: integrationId },
              { ...input, systemPrincipalId: otherSystemId },
              { ...input, tenantId: otherTenantId },
              { ...input, ownedDatabase: { ...ownedDatabase } },
            ];
            for (const refused of refusedInputs) {
              expect(Exit.isFailure(yield* makeOwnedSystemWriterWorkloadControlNative(refused).pipe(Effect.exit))).toBe(
                true,
              );
            }
            const wrongPurpose = yield* makeIsolatedNativeDatabaseFixture({
              mode: 'empty',
              purpose: 'implementation-1118-symmy-job-admission',
            });
            expect(
              Exit.isFailure(
                yield* makeOwnedSystemWriterWorkloadControlNative({ ...input, ownedDatabase: wrongPurpose }).pipe(
                  Effect.exit,
                ),
              ),
            ).toBe(true);
            const expiredController = yield* Effect.scoped(makeOwnedSystemWriterWorkloadControlNative(input));
            expect(Exit.isFailure(yield* expiredController.revoke().pipe(Effect.exit))).toBe(true);
            const group = yield* makeOwnedSystemWriterWorkloadControlNative(input);
            const stale = yield* makeOwnedSystemWriterWorkloadControlNative(input);
            expect(Exit.isFailure(yield* group.rebind().pipe(Effect.exit))).toBe(true);
            yield* group.revoke();
            expect(Exit.isFailure(yield* group.revoke().pipe(Effect.exit))).toBe(true);
            expect(Exit.isFailure(yield* stale.revoke().pipe(Effect.exit))).toBe(true);
            expect(Exit.isFailure(yield* makeOwnedSystemWriterWorkloadControlNative(input).pipe(Effect.exit))).toBe(
              true,
            );
            const ended = yield* database
              .select()
              .from(accessWorkloadBindings)
              .where(eq(accessWorkloadBindings.bindingId, group.originalBinding.bindingId));
            expect(ended).toHaveLength(1);
            expect(ended[0]?.status).toBe('revoked');
            expect(ended[0]?.revokedAt).toBeInstanceOf(Date);
            const rebound = yield* group.rebind();
            expect(rebound.bindingId).not.toBe(group.originalBinding.bindingId);
            expect(rebound.incarnation).not.toBe(group.originalBinding.incarnation);
            expect(
              yield* database
                .select()
                .from(accessWorkloadBindings)
                .where(eq(accessWorkloadBindings.bindingId, group.originalBinding.bindingId)),
            ).toEqual(ended);
            expect(Exit.isFailure(yield* group.rebind().pipe(Effect.exit))).toBe(true);
            expect(yield* readRows).toEqual(originalReads);
            expect(yield* integrationRows).toEqual(afterReader);
            expect(
              yield* database
                .select()
                .from(accessWorkloadBindings)
                .where(
                  and(
                    eq(accessWorkloadBindings.tenantId, tenantId),
                    eq(accessWorkloadBindings.principalId, systemPrincipalId),
                    eq(accessWorkloadBindings.workloadKey, inventoryWriter),
                  ),
                ),
            ).toEqual(originalInventory);
            const inventory = yield* makeOwnedSystemWriterWorkloadControlNative({
              ...input,
              workloadKey: inventoryWriter,
            });
            yield* inventory.revoke();
            const restoredInventory = yield* inventory.rebind();
            expect(restoredInventory.bindingId).not.toBe(inventory.originalBinding.bindingId);
            expect(restoredInventory.incarnation).not.toBe(inventory.originalBinding.incarnation);
            expect(yield* readRows).toEqual(originalReads);
            const inactiveOperator = yield* makeOwnedSystemWriterWorkloadControlNative(input);
            yield* database
              .update(principals)
              .set({ disabledAt: DateTime.toDateUtc(yield* DateTime.now), status: 'disabled' })
              .where(eq(principals.principalId, operatorPrincipalId));
            expect(Exit.isFailure(yield* inactiveOperator.revoke().pipe(Effect.exit))).toBe(true);
            yield* database
              .update(principals)
              .set({ disabledAt: null, status: 'active' })
              .where(eq(principals.principalId, operatorPrincipalId));
            const closed = yield* makeOwnedSystemWriterWorkloadControlNative(input);
            // A corrupt fixture's duplicate live rows must not be selected arbitrarily.
            yield* database.execute(sql`drop index core.access_workload_bindings_active_uk`, 'objects');
            yield* database.insert(accessWorkloadBindings).values({
              bindingId: yield* crypto.randomUUIDv4(),
              incarnation: yield* crypto.randomUUIDv4(),
              principalId: systemPrincipalId,
              status: 'active',
              tenantId,
              workloadKey: groupWriter,
            });
            expect(Exit.isFailure(yield* makeOwnedSystemWriterWorkloadControlNative(input).pipe(Effect.exit))).toBe(
              true,
            );
            expect(yield* readRows).toEqual(originalReads);
            return { closed, input };
          }),
        );
        expect(Exit.isFailure(yield* makeOwnedSystemWriterWorkloadControlNative(expired.input).pipe(Effect.exit))).toBe(
          true,
        );
        expect(Exit.isFailure(yield* expired.closed.revoke().pipe(Effect.exit))).toBe(true);
      }),
    30_000,
  );
});
