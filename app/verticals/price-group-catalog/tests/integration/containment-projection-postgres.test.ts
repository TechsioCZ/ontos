import { randomUUID } from 'node:crypto';

import { scopedRoutineInvokerFromTransaction } from '@app/core-runtime';
import { eq, sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromPool,
  testDatabasePools,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  priceGroupCatalogRelations,
  priceGroupContainmentProjectionIntents,
  priceGroupDefinitionEffectiveIntervals,
  priceGroupDefinitionRevisions,
  priceGroups,
} from '../../src/database/schema.ts';
import { priceGroupCatalogPersistenceFromRoutineInvoker } from '../../src/persistence/price-group-catalog-persistence.ts';

it.live('rolls back the Price Group and its durable containment intent in the same SQL transaction', () =>
  Effect.scoped(
    Effect.gen(function* rollbackContainmentIntent() {
      const tenantId = randomUUID();
      const principalId = randomUUID();
      const actionInvocationId = randomUUID();
      const { admin: adminPool, runtimePool } = yield* testDatabasePools;
      const admin = yield* makeTestDatabaseFromPool(adminPool, priceGroupCatalogRelations);
      const runtime = yield* makeTestDatabaseFromPool(runtimePool, priceGroupCatalogRelations);
      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanupRolledBackTenant() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            yield* transaction
              .delete(priceGroupContainmentProjectionIntents)
              .where(eq(priceGroupContainmentProjectionIntents.tenantId, tenantId));
            yield* transaction
              .delete(priceGroupDefinitionEffectiveIntervals)
              .where(eq(priceGroupDefinitionEffectiveIntervals.tenantId, tenantId));
            yield* transaction
              .delete(priceGroupDefinitionRevisions)
              .where(eq(priceGroupDefinitionRevisions.tenantId, tenantId));
            yield* transaction.delete(priceGroups).where(eq(priceGroups.tenantId, tenantId));
            yield* transaction.execute(
              sql`delete from price_group_catalog.price_group_catalog_ledger where tenant_id = ${tenantId}::uuid`,
            );
          }),
        );
      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

      const scope = {
        authMethod: 'system' as const,
        correlationId: 'containment-projection-rollback',
        principalId,
        tenantId,
      };
      const rollbackFailure = yield* Effect.flip(
        runtime.transaction((transaction) =>
          Effect.gen(function* createThenRollBack() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
            const invoker = scopedRoutineInvokerFromTransaction(
              (statement) => transaction.execute(statement, 'objects'),
              scope,
            );
            yield* priceGroupCatalogPersistenceFromRoutineInvoker(invoker, scope).createPriceGroup({
              actingPrincipalId: principalId,
              actionInvocationId,
              businessCode: 'ROLLBACK_PROOF',
              classificationPurpose: 'Proves atomic containment intent rollback.',
              compatibilityContracts: [{ contractId: 'commerce.customer-price-group-assignment', version: 1 }],
              description: 'This Price Group must never survive its failed transaction.',
              displayName: 'Rollback proof',
              effectiveFrom: new Date('2026-10-01T00:00:00.000Z'),
              expectedCatalogRevision: 0,
              meaningFingerprint: 'f'.repeat(64),
              reason: 'Exercise owner transaction rollback.',
              trustedEffectiveAt: new Date('2026-09-23T12:00:00.000Z'),
            });
            return yield* Effect.fail('force-owner-transaction-rollback' as const);
          }),
        ),
      );
      expect(rollbackFailure).toBe('force-owner-transaction-rollback');

      const persistedGroups = yield* admin.select().from(priceGroups).where(eq(priceGroups.tenantId, tenantId));
      const persistedIntents = yield* admin
        .select()
        .from(priceGroupContainmentProjectionIntents)
        .where(eq(priceGroupContainmentProjectionIntents.tenantId, tenantId));
      expect(persistedGroups).toEqual([]);
      expect(persistedIntents).toEqual([]);
    }),
  ),
);
