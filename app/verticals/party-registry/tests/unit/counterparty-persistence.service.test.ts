/* eslint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type -- This focused test harness models the narrow Drizzle native Effect query surface used by the owner-local service. expires: 2026-12-31. */
import type { Table } from 'drizzle-orm';
import { getTableName } from 'drizzle-orm';
import { DateTime, Effect, Predicate, Struct } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import {
  addCounterpartyRoleRecord,
  createCounterpartyRecord,
  endCounterpartyRoleRecord,
  findCounterpartyRecord,
  listCounterpartyRoleHistory,
} from '../../src/services/counterparty-persistence.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const counterpartyId = '30000000-0000-4000-8000-000000000001';
const partyId = '40000000-0000-4000-8000-000000000001';
const rolePeriodId = '50000000-0000-4000-8000-000000000001';
const actionInvocationId = '60000000-0000-4000-8000-000000000001';
const principalId = '70000000-0000-4000-8000-000000000001';
const date = (instant: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(instant));

const counterpartyRow = {
  archivedAt: null,
  counterpartyId,
  createdAt: date('2020-01-01T00:00:00.000Z'),
  legalEntityId,
  partyId,
  tenantId,
};

const roleRow = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  acceptedByActionInvocationId: actionInvocationId,
  acceptedByPrincipalId: principalId,
  addEvidenceRefs: ['contract:add'],
  addReason: 'SIGNED_CONTRACT',
  counterpartyId,
  endEvidenceRefs: null,
  endProvenanceMethod: null,
  endProvenanceSource: null,
  endReason: null,
  endedByActionInvocationId: null,
  endedByPrincipalId: null,
  endedRecordedAt: null,
  isCurrent: true,
  legalEntityId,
  policyVersion: 'counterparty-role.v1',
  provenanceMethod: 'SIGNED_CONTRACT',
  provenanceSource: 'contracts.core',
  recordedAt: date('2020-01-01T00:00:00.000Z'),
  rolePeriodId,
  roleType: 'CUSTOMER',
  state: 'ACTIVE',
  tenantId,
  validFrom: date('2020-01-01T00:00:00.000Z'),
  validTo: null,
  ...overrides,
});

interface TransactionHarness {
  readonly insertedTables: readonly string[];
  readonly insertValues: readonly Readonly<Record<string, unknown>>[];
  readonly selectedTables: readonly string[];
  readonly transaction: Parameters<typeof endCounterpartyRoleRecord>[0];
  readonly updateSets: readonly Readonly<Record<string, unknown>>[];
}

const transactionHarness = (
  selects: readonly (readonly Readonly<Record<string, unknown>>[])[],
  updates: readonly (readonly Readonly<Record<string, unknown>>[])[] = [],
  inserts: readonly (readonly Readonly<Record<string, unknown>>[])[] = [],
): TransactionHarness => {
  const selectQueue = [...selects];
  const updateQueue = [...updates];
  const insertQueue = [...inserts];
  const insertedTables: string[] = [];
  const insertValues: Readonly<Record<string, unknown>>[] = [];
  const selectedTables: string[] = [];
  const updateSets: Readonly<Record<string, unknown>>[] = [];
  const select = () => {
    const rows = selectQueue.shift() ?? [];
    const chain = Object.assign(Effect.succeed(rows), {
      for: () => Effect.succeed(rows),
      from: (table: Table) => {
        selectedTables.push(getTableName(table));
        return chain;
      },
      limit: () => chain,
      orderBy: () => chain,
      where: () => chain,
    });
    return chain;
  };
  const update = () => {
    const chain = {
      returning: () => Effect.succeed(updateQueue.shift() ?? []),
      set: (values: Readonly<Record<string, unknown>>) => {
        updateSets.push(values);
        return chain;
      },
      where: () => chain,
    };
    return chain;
  };
  const insert = (table: Table) => {
    insertedTables.push(getTableName(table));
    const chain = Object.assign(
      Effect.sync(() => []),
      {
        onConflictDoNothing: () => chain,
        onConflictDoUpdate: () => chain,
        returning: () => Effect.succeed(insertQueue.shift() ?? []),
        values: (values: Readonly<Record<string, unknown>>) => {
          insertValues.push(values);
          return chain;
        },
      },
    );
    return chain;
  };
  // SAFETY: the harness implements precisely the select/update fluent methods exercised here.
  const transaction = { insert, select, update } as unknown as Parameters<typeof endCounterpartyRoleRecord>[0];
  return {
    insertValues,
    insertedTables,
    selectedTables,
    transaction,
    updateSets,
  };
};

const endInput = (validTo: string, method: string) => ({
  actionInvocationId,
  counterpartyId,
  legalEntityId,
  policyVersion: 'counterparty-role.v1',
  principalId,
  provenance: {
    evidenceReference: 'contract:end',
    method,
    source: 'contracts.core',
  },
  rolePeriodId,
  tenantId,
  validTo,
});

it.effect('keeps a future-ended role active until its exclusive effective end', () =>
  Effect.gen(function* testScenario1() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-03T00:00:00.000Z')));
    const futureEnd = '2099-01-01T00:00:00.000Z';
    const updated = roleRow({
      endEvidenceRefs: ['contract:end'],
      endProvenanceMethod: 'CONFIRMED_CUSTOMER_RELATIONSHIP_END',
      endProvenanceSource: 'contracts.core',
      endReason: 'CONFIRMED_CUSTOMER_RELATIONSHIP_END',
      endedByActionInvocationId: actionInvocationId,
      endedByPrincipalId: principalId,
      endedRecordedAt: date('2026-09-03T00:00:00.000Z'),
      validTo: date(futureEnd),
    });
    const harness = transactionHarness([[counterpartyRow], [roleRow()]], [[updated]]);

    const result = yield* endCounterpartyRoleRecord(
      harness.transaction,
      endInput(futureEnd, 'CONFIRMED_CUSTOMER_RELATIONSHIP_END'),
    );

    expect(Predicate.isTagged(result, 'found')).toBe(true);
    if (!Predicate.isTagged(result, 'found')) {
      return yield* Effect.die(new Error('Unexpected result variant'));
    }
    expect(harness.updateSets[0]?.['state']).toBe('ACTIVE');
    expect(harness.updateSets[0]?.['isCurrent']).toBe(true);
    expect(harness.updateSets[0]?.['endProvenanceSource']).toBe('contracts.core');
    expect(harness.updateSets[0]?.['endProvenanceMethod']).toBe('CONFIRMED_CUSTOMER_RELATIONSHIP_END');
    expect(harness.insertValues.length).toBe(2);
    expect(harness.insertValues[1]?.['endProvenanceMethod']).toBe('CONFIRMED_CUSTOMER_RELATIONSHIP_END');
  }),
);

it.effect('records a retrospective end as historical without deleting the role period', () =>
  Effect.gen(function* testScenario2() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-03T00:00:00.000Z')));
    const pastEnd = '2021-01-01T00:00:00.000Z';
    const updated = roleRow({
      endEvidenceRefs: ['contract:end'],
      endProvenanceMethod: 'CONFIRMED_CUSTOMER_RELATIONSHIP_END',
      endProvenanceSource: 'contracts.core',
      endReason: 'CONFIRMED_CUSTOMER_RELATIONSHIP_END',
      state: 'ENDED',
      validTo: date(pastEnd),
    });
    const harness = transactionHarness([[counterpartyRow], [roleRow()]], [[updated]]);

    yield* endCounterpartyRoleRecord(harness.transaction, endInput(pastEnd, 'CONFIRMED_CUSTOMER_RELATIONSHIP_END'));

    expect(harness.updateSets[0]?.['state']).toBe('ENDED');
    expect(harness.updateSets[0]?.['isCurrent']).toBe(false);
  }),
);

it.effect('rejects inactivity evidence before persisting a CUSTOMER end', () =>
  Effect.gen(function* testScenario3() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-03T00:00:00.000Z')));
    const harness = transactionHarness([[counterpartyRow], [roleRow()]]);

    const result = yield* endCounterpartyRoleRecord(
      harness.transaction,
      endInput('2027-01-01T00:00:00.000Z', 'ENGAGEMENT_INACTIVITY'),
    );

    expect(Predicate.isTagged(result, 'evidence_insufficient')).toBe(true);
    expect(Struct.omit(result, ['_tag'])).toEqual({
      method: 'ENGAGEMENT_INACTIVITY',
      roleType: 'CUSTOMER',
    });
    expect(harness.updateSets.length).toBe(0);
  }),
);

it.effect('reuses an exactly repeated end without another write', () =>
  Effect.gen(function* testScenario4() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-03T00:00:00.000Z')));
    const validTo = '2025-01-01T00:00:00.000Z';
    const ended = roleRow({
      endEvidenceRefs: ['contract:end'],
      endProvenanceMethod: 'CONFIRMED_CUSTOMER_RELATIONSHIP_END',
      endProvenanceSource: 'contracts.core',
      endReason: 'CONFIRMED_CUSTOMER_RELATIONSHIP_END',
      state: 'ENDED',
      validTo: date(validTo),
    });
    const harness = transactionHarness([[counterpartyRow], [ended]]);

    const result = yield* endCounterpartyRoleRecord(
      harness.transaction,
      endInput(validTo, 'CONFIRMED_CUSTOMER_RELATIONSHIP_END'),
    );

    expect(Predicate.isTagged(result, 'found')).toBe(true);
    if (!Predicate.isTagged(result, 'found')) {
      return yield* Effect.die(new Error('Unexpected result variant'));
    }
    expect(result.changed).toBe(false);
    expect(harness.updateSets.length).toBe(0);
  }),
);

it.effect('reads end provenance independently from the role-add provenance', () =>
  Effect.gen(function* testScenario5() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-03T00:00:00.000Z')));
    const ended = roleRow({
      endEvidenceRefs: ['contract:end'],
      endProvenanceMethod: 'CONFIRMED_CUSTOMER_RELATIONSHIP_END',
      endProvenanceSource: 'customer-offboarding.core',
      endReason: 'Customer agreement terminated',
      state: 'ENDED',
      validTo: date('2025-01-01T00:00:00.000Z'),
    });
    const harness = transactionHarness([[counterpartyRow], [ended]]);

    const result = yield* listCounterpartyRoleHistory(harness.transaction, tenantId, legalEntityId, counterpartyId);

    expect(Predicate.isTagged(result, 'found')).toBe(true);
    if (!Predicate.isTagged(result, 'found')) {
      return yield* Effect.die(new Error('Unexpected result variant'));
    }
    expect(result.value[0]?.endProvenance).toEqual({
      evidenceReference: 'contract:end',
      method: 'CONFIRMED_CUSTOMER_RELATIONSHIP_END',
      reason: 'Customer agreement terminated',
      source: 'customer-offboarding.core',
    });
  }),
);

it.effect('allows the authorized tenant-admin path to read history without payload Legal Entity data', () =>
  Effect.gen(function* testScenario6() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-03T00:00:00.000Z')));
    const harness = transactionHarness([[{ ...counterpartyRow, storedPartyId: partyId }], [roleRow()]]);

    const result = yield* listCounterpartyRoleHistory(harness.transaction, tenantId, undefined, counterpartyId);

    expect(Predicate.isTagged(result, 'found')).toBe(true);
    if (!Predicate.isTagged(result, 'found')) {
      return yield* Effect.die(new Error('Unexpected result variant'));
    }
    expect(result.value[0]?.roleType).toBe('CUSTOMER');
    expect(harness.selectedTables).toEqual(['counterparty_admin_read_models', 'counterparty_role_admin_read_models']);
  }),
);

it.effect('rejects an alias Party create target with canonical survivor guidance', () =>
  Effect.gen(function* testScenario7() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-03T00:00:00.000Z')));
    const survivorId = '40000000-0000-4000-8000-000000000002';
    const harness = transactionHarness([
      [{ aliasPartyId: partyId, canonicalPartyId: survivorId, tenantId }],
      [],
      [{ partyId: survivorId }],
    ]);

    const result = yield* createCounterpartyRecord(harness.transaction, {
      actionInvocationId,
      legalEntityId,
      partyId,
      policyVersion: 'counterparty-context.v1',
      principalId,
      provenance: {
        evidenceReference: 'contract:create',
        method: 'SIGNED_CONTRACT',
        reason: 'Signed commercial agreement',
        source: 'contracts.core',
      },
      tenantId,
    });

    expect(Predicate.isTagged(result, 'party_alias')).toBe(true);
    if (!Predicate.isTagged(result, 'party_alias')) {
      return yield* Effect.die(new Error('Unexpected result variant'));
    }
    expect(result.canonicalPartyRef.resourceId).toBe(survivorId);
    expect(harness.insertValues.length).toBe(0);
  }),
);

it.effect('admin detail follows a complete Party alias chain while retaining the stored reference', () =>
  Effect.gen(function* testScenario8() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-03T00:00:00.000Z')));
    const middleId = '40000000-0000-4000-8000-000000000002';
    const survivorId = '40000000-0000-4000-8000-000000000003';
    const harness = transactionHarness([
      [{ ...counterpartyRow, storedPartyId: partyId }],
      [{ aliasPartyId: partyId, canonicalPartyId: middleId, tenantId }],
      [{ aliasPartyId: middleId, canonicalPartyId: survivorId, tenantId }],
      [],
      [{ partyId: survivorId }],
      [
        {
          archivedAt: null,
          currentDisplayName: 'Survivor',
          currentType: 'ORGANIZATION',
          partyId: survivorId,
          tenantId,
        },
      ],
      [],
    ]);

    const result = yield* findCounterpartyRecord(harness.transaction, tenantId, undefined, counterpartyId);

    expect(Predicate.isTagged(result, 'found')).toBe(true);
    if (!Predicate.isTagged(result, 'found')) {
      return yield* Effect.die(new Error('Unexpected result variant'));
    }
    expect(result.value.party.storedPartyRef.resourceId).toBe(partyId);
    expect(result.value.party.canonicalPartyRef.resourceId).toBe(survivorId);
    expect(result.value.legalEntityRef.resourceId).toBe(legalEntityId);
    expect(harness.selectedTables.includes('counterparties')).toBe(false);
    expect(harness.selectedTables.includes('counterparty_role_periods')).toBe(false);
  }),
);

it.effect('creates the tenant-admin snapshot atomically without creating an implicit role', () =>
  Effect.gen(function* testScenario9() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-03T00:00:00.000Z')));
    const party = { archivedAt: null, partyId, tenantId };
    const harness = transactionHarness([[], [{ partyId }], [], [{ partyId }], [party]], [], [[counterpartyRow]]);

    const result = yield* createCounterpartyRecord(harness.transaction, {
      actionInvocationId,
      legalEntityId,
      partyId,
      policyVersion: 'counterparty-context.v1',
      principalId,
      provenance: {
        evidenceReference: 'contract:create',
        method: 'SIGNED_CONTRACT',
        reason: 'Signed commercial agreement',
        source: 'contracts.core',
      },
      tenantId,
    });

    expect(Predicate.isTagged(result, 'found')).toBe(true);
    if (!Predicate.isTagged(result, 'found')) {
      return yield* Effect.die(new Error('Unexpected result variant'));
    }
    expect(harness.insertedTables).toEqual(['counterparties', 'counterparty_admin_read_models']);
    expect(harness.insertValues[1]?.['storedPartyId']).toBe(partyId);
  }),
);

it.effect('adds a future role and its admin history projection in the same transaction seam', () =>
  Effect.gen(function* testScenario10() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-03T00:00:00.000Z')));
    const futureStart = '2099-01-01T00:00:00.000Z';
    const futureRole = roleRow({
      isCurrent: false,
      validFrom: date(futureStart),
    });
    const harness = transactionHarness(
      [[counterpartyRow], [], [{ partyId }], [{ archivedAt: null, partyId, tenantId }], []],
      [],
      [[futureRole]],
    );

    const result = yield* addCounterpartyRoleRecord(harness.transaction, {
      actionInvocationId,
      counterpartyId,
      legalEntityId,
      policyVersion: 'counterparty-role.v1',
      principalId,
      provenance: {
        evidenceReference: 'contract:add',
        method: 'SIGNED_CONTRACT',
        source: 'contracts.core',
      },
      roleType: 'CUSTOMER',
      tenantId,
      validFrom: futureStart,
      validTo: null,
    });

    expect(Predicate.isTagged(result, 'found')).toBe(true);
    if (!Predicate.isTagged(result, 'found')) {
      return yield* Effect.die(new Error('Unexpected result variant'));
    }
    expect(harness.insertValues[0]?.['isCurrent']).toBe(false);
    expect(harness.insertedTables).toEqual([
      'counterparty_role_periods',
      'counterparty_admin_read_models',
      'counterparty_role_admin_read_models',
    ]);
  }),
);
