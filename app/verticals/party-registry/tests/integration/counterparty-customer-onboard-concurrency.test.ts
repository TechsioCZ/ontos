import { eq, sql } from 'drizzle-orm';
import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import { purgeFixtureRows } from '../../../../packages/core-runtime/tests/support/fixture-cleanup.ts';
import {
  parties,
  partyRelations,
  counterparties,
  counterpartyAdminReadModels,
  counterpartyRoleAdminReadModels,
  counterpartyRolePeriods,
} from '../../src/db/schema.ts';
import type { PartyTransaction } from '../../src/db/types.ts';
import { onboardCounterpartyCustomerRecord } from '../../src/services/counterparty-persistence.service.ts';
import { openBoundaryDatabases } from '../support/database-boundary.ts';

const tenantId = '91000000-0000-4000-8000-000000000001';
const legalEntityId = '92000000-0000-4000-8000-000000000001';
const partyId = '93000000-0000-4000-8000-000000000001';
const rollbackPartyId = '93000000-0000-4000-8000-000000000002';
const principalId = '94000000-0000-4000-8000-000000000001';
const rolePeriodStart = '2026-01-01T00:00:00.000Z';

it.live('PostgreSQL locking yields one Counterparty and one equivalent CUSTOMER period for concurrent requests', () =>
  Effect.gen(function* onboardConcurrency() {
    const { admin, runtime } = yield* openBoundaryDatabases(
      (pool) => makeTestDatabaseFromPool(pool, partyRelations),
      2,
    );
    const cleanup = purgeFixtureRows(
      [
        counterpartyRoleAdminReadModels,
        counterpartyAdminReadModels,
        counterpartyRolePeriods,
        counterparties,
        parties,
      ].map((table) => admin.delete(table).where(eq(table.tenantId, tenantId))),
    );
    yield* Effect.acquireRelease(cleanup, () => cleanup.pipe(Effect.orDie));
    yield* admin.insert(parties).values({
      currentDisplayName: 'Concurrent customer',
      currentType: 'ORGANIZATION',
      partyId,
      tenantId,
    });

    const scoped = <Value, Failure>(operation: (transaction: PartyTransaction) => Effect.Effect<Value, Failure>) =>
      runtime.transaction((transaction) =>
        Effect.gen(function* scopedTransaction() {
          yield* transaction.execute(
            sql`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
            'objects',
          );
          return yield* operation(transaction);
        }),
      );
    const input = (actionInvocationId: string) => ({
      actionInvocationId,
      counterpartyProvenance: {
        evidenceReference: 'concurrency:context',
        method: 'SIGNED_CONTRACT',
        reason: 'Concurrent contract fixture',
        source: 'party-registry.integration',
      },
      customerEvidence: {
        evidenceReference: 'concurrency:customer',
        method: 'SIGNED_CONTRACT',
        reason: 'Concurrent customer fixture',
        source: 'party-registry.integration',
      },
      legalEntityId,
      partyId,
      policyVersion: 'counterparty-customer-onboard.v1',
      principalId,
      provenance: {
        evidenceReference: 'concurrency:customer',
        method: 'SIGNED_CONTRACT',
        reason: 'Concurrent customer fixture',
        source: 'party-registry.integration',
      },
      tenantId,
      validFrom: rolePeriodStart,
      validTo: null,
    });
    const results = yield* Effect.forEach(
      ['95000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000002'],
      (actionInvocationId) =>
        scoped((transaction) => onboardCounterpartyCustomerRecord(transaction, input(actionInvocationId))),
      { concurrency: 'unbounded' },
    );

    expect(results.every((result) => Predicate.isTagged(result, 'onboarded'))).toBe(true);
    expect(
      results.filter((result) => Predicate.isTagged(result, 'onboarded') && result.counterpartyCreated),
    ).toHaveLength(1);
    expect(
      results.filter((result) => Predicate.isTagged(result, 'onboarded') && result.rolePeriodCreated),
    ).toHaveLength(1);
    expect(yield* admin.select().from(counterparties).where(eq(counterparties.tenantId, tenantId))).toHaveLength(1);
    const roles = yield* admin
      .select()
      .from(counterpartyRolePeriods)
      .where(eq(counterpartyRolePeriods.tenantId, tenantId));
    expect(roles).toHaveLength(1);
    expect(roles[0]?.roleType).toBe('CUSTOMER');
    expect(roles[0]?.validFrom.toISOString()).toBe(rolePeriodStart);
    expect(roles[0]?.validTo).toBe(null);

    yield* admin.insert(parties).values({
      currentDisplayName: 'Rollback customer',
      currentType: 'ORGANIZATION',
      partyId: rollbackPartyId,
      tenantId,
    });
    const roleWriteFailure = yield* scoped((transaction) =>
      onboardCounterpartyCustomerRecord(transaction, {
        ...input('95000000-0000-4000-8000-000000000003'),
        partyId: rollbackPartyId,
        validTo: '2025-01-01T00:00:00.000Z',
      }),
    ).pipe(Effect.flip);
    expect(Predicate.isTagged(roleWriteFailure, 'CounterpartyPersistenceUnavailable')).toBe(true);
    expect(yield* admin.select().from(counterparties).where(eq(counterparties.partyId, rollbackPartyId))).toHaveLength(
      0,
    );
  }),
);
