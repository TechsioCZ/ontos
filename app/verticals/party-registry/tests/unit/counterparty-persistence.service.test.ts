/* eslint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type, unicorn/no-thenable -- This focused test harness models the narrow Drizzle fluent/PromiseLike surface used by the owner-local service. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { getTableName } from 'drizzle-orm';
import type { Table } from 'drizzle-orm';
import { DateTime, Effect } from 'effect';
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
    const chain = {
      for: () => Promise.resolve(rows),
      from: (table: Table) => {
        selectedTables.push(getTableName(table));
        return chain;
      },
      limit: () => chain,
      orderBy: () => chain,
      then: <Result>(
        onfulfilled?: ((value: readonly Readonly<Record<string, unknown>>[]) => Result) | null,
      ) => Promise.resolve(rows).then(onfulfilled),
      where: () => chain,
    };
    return chain;
  };
  const update = () => {
    const chain = {
      returning: () => Promise.resolve(updateQueue.shift() ?? []),
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
    const chain = {
      onConflictDoNothing: () => chain,
      onConflictDoUpdate: () => chain,
      returning: () => Promise.resolve(insertQueue.shift() ?? []),
      then: <Result>(
        onfulfilled?: ((value: readonly Readonly<Record<string, unknown>>[]) => Result) | null,
      ) => Promise.resolve([]).then(onfulfilled),
      values: (values: Readonly<Record<string, unknown>>) => {
        insertValues.push(values);
        return chain;
      },
    };
    return chain;
  };
  // SAFETY: the harness implements precisely the select/update fluent methods exercised here.
  const transaction = { insert, select, update } as unknown as Parameters<
    typeof endCounterpartyRoleRecord
  >[0];
  return { insertValues, insertedTables, selectedTables, transaction, updateSets };
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

test('keeps a future-ended role active until its exclusive effective end', () => {
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

  return Effect.runPromise(
    endCounterpartyRoleRecord(
      harness.transaction,
      endInput(futureEnd, 'CONFIRMED_CUSTOMER_RELATIONSHIP_END'),
    ),
  ).then((result) => {
    assert.equal(result._tag, 'found');
    assert.equal(harness.updateSets[0]?.['state'], 'ACTIVE');
    assert.equal(harness.updateSets[0]?.['isCurrent'], true);
    assert.equal(harness.updateSets[0]?.['endProvenanceSource'], 'contracts.core');
    assert.equal(
      harness.updateSets[0]?.['endProvenanceMethod'],
      'CONFIRMED_CUSTOMER_RELATIONSHIP_END',
    );
    assert.equal(harness.insertValues.length, 2);
    assert.equal(
      harness.insertValues[1]?.['endProvenanceMethod'],
      'CONFIRMED_CUSTOMER_RELATIONSHIP_END',
    );
  });
});

test('records a retrospective end as historical without deleting the role period', () => {
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

  return Effect.runPromise(
    endCounterpartyRoleRecord(
      harness.transaction,
      endInput(pastEnd, 'CONFIRMED_CUSTOMER_RELATIONSHIP_END'),
    ),
  ).then(() => {
    assert.equal(harness.updateSets[0]?.['state'], 'ENDED');
    assert.equal(harness.updateSets[0]?.['isCurrent'], false);
  });
});

test('rejects inactivity evidence before persisting a CUSTOMER end', () => {
  const harness = transactionHarness([[counterpartyRow], [roleRow()]]);

  return Effect.runPromise(
    endCounterpartyRoleRecord(
      harness.transaction,
      endInput('2027-01-01T00:00:00.000Z', 'ENGAGEMENT_INACTIVITY'),
    ),
  ).then((result) => {
    assert.deepEqual(result, {
      _tag: 'evidence_insufficient',
      method: 'ENGAGEMENT_INACTIVITY',
      roleType: 'CUSTOMER',
    });
    assert.equal(harness.updateSets.length, 0);
  });
});

test('reuses an exactly repeated end without another write', () => {
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

  return Effect.runPromise(
    endCounterpartyRoleRecord(
      harness.transaction,
      endInput(validTo, 'CONFIRMED_CUSTOMER_RELATIONSHIP_END'),
    ),
  ).then((result) => {
    assert.equal(result._tag, 'found');
    assert.equal(result._tag === 'found' && result.changed, false);
    assert.equal(harness.updateSets.length, 0);
  });
});

test('reads end provenance independently from the role-add provenance', () => {
  const ended = roleRow({
    endEvidenceRefs: ['contract:end'],
    endProvenanceMethod: 'CONFIRMED_CUSTOMER_RELATIONSHIP_END',
    endProvenanceSource: 'customer-offboarding.core',
    endReason: 'Customer agreement terminated',
    state: 'ENDED',
    validTo: date('2025-01-01T00:00:00.000Z'),
  });
  const harness = transactionHarness([[counterpartyRow], [ended]]);

  return Effect.runPromise(
    listCounterpartyRoleHistory(harness.transaction, tenantId, legalEntityId, counterpartyId),
  ).then((result) => {
    assert.equal(result._tag, 'found');
    assert.deepEqual(result._tag === 'found' && result.value[0]?.endProvenance, {
      evidenceReference: 'contract:end',
      method: 'CONFIRMED_CUSTOMER_RELATIONSHIP_END',
      reason: 'Customer agreement terminated',
      source: 'customer-offboarding.core',
    });
  });
});

test('allows the authorized tenant-admin path to read history without payload Legal Entity data', () => {
  const harness = transactionHarness([
    [{ ...counterpartyRow, storedPartyId: partyId }],
    [roleRow()],
  ]);

  return Effect.runPromise(
    listCounterpartyRoleHistory(harness.transaction, tenantId, undefined, counterpartyId),
  ).then((result) => {
    assert.equal(result._tag, 'found');
    assert.equal(result._tag === 'found' && result.value[0]?.roleType, 'CUSTOMER');
    assert.deepEqual(harness.selectedTables, [
      'counterparty_admin_read_models',
      'counterparty_role_admin_read_models',
    ]);
  });
});

test('rejects an alias Party create target with canonical survivor guidance', () => {
  const survivorId = '40000000-0000-4000-8000-000000000002';
  const harness = transactionHarness([
    [{ aliasPartyId: partyId, canonicalPartyId: survivorId, tenantId }],
    [],
    [{ partyId: survivorId }],
  ]);

  return Effect.runPromise(
    createCounterpartyRecord(harness.transaction, {
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
    }),
  ).then((result) => {
    assert.equal(result._tag, 'party_alias');
    assert.equal(result._tag === 'party_alias' && result.canonicalPartyRef.resourceId, survivorId);
    assert.equal(harness.insertValues.length, 0);
  });
});

test('admin detail follows a complete Party alias chain while retaining the stored reference', () => {
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

  return Effect.runPromise(
    findCounterpartyRecord(harness.transaction, tenantId, undefined, counterpartyId),
  ).then((result) => {
    assert.equal(result._tag, 'found');
    assert.equal(result._tag === 'found' && result.value.party.storedPartyRef.resourceId, partyId);
    assert.equal(
      result._tag === 'found' && result.value.party.canonicalPartyRef.resourceId,
      survivorId,
    );
    assert.equal(result._tag === 'found' && result.value.legalEntityRef.resourceId, legalEntityId);
    assert.equal(harness.selectedTables.includes('counterparties'), false);
    assert.equal(harness.selectedTables.includes('counterparty_role_periods'), false);
  });
});

test('creates the tenant-admin snapshot atomically without creating an implicit role', () => {
  const party = { archivedAt: null, partyId, tenantId };
  const harness = transactionHarness(
    [[], [{ partyId }], [], [{ partyId }], [party]],
    [],
    [[counterpartyRow]],
  );

  return Effect.runPromise(
    createCounterpartyRecord(harness.transaction, {
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
    }),
  ).then((result) => {
    assert.equal(result._tag, 'found');
    assert.deepEqual(harness.insertedTables, ['counterparties', 'counterparty_admin_read_models']);
    assert.equal(harness.insertValues[1]?.['storedPartyId'], partyId);
  });
});

test('adds a future role and its admin history projection in the same transaction seam', () => {
  const futureStart = '2099-01-01T00:00:00.000Z';
  const futureRole = roleRow({ isCurrent: false, validFrom: date(futureStart) });
  const harness = transactionHarness(
    [[counterpartyRow], [], [{ partyId }], [{ archivedAt: null, partyId, tenantId }], []],
    [],
    [[futureRole]],
  );

  return Effect.runPromise(
    addCounterpartyRoleRecord(harness.transaction, {
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
    }),
  ).then((result) => {
    assert.equal(result._tag, 'found');
    assert.equal(harness.insertValues[0]?.['isCurrent'], false);
    assert.deepEqual(harness.insertedTables, [
      'counterparty_role_periods',
      'counterparty_admin_read_models',
      'counterparty_role_admin_read_models',
    ]);
  });
});
