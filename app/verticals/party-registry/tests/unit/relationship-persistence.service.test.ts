// @effect-diagnostics asyncFunction:off globalDate:off
/* eslint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type, unicorn/no-thenable -- This focused harness models only the Drizzle system boundary used by the Relationship service. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import {
  createPartyRelationshipRecord,
  endPartyRelationshipRecord,
  findPartyRelationshipRecord,
  updatePartyRelationshipRecord,
} from '../../src/services/party-relationship-persistence.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const fromPartyId = '20000000-0000-4000-8000-000000000001';
const toPartyId = '30000000-0000-4000-8000-000000000001';
const relationshipId = '40000000-0000-4000-8000-000000000001';
const actionInvocationId = '50000000-0000-4000-8000-000000000001';
const principalId = '60000000-0000-4000-8000-000000000001';

const ref = (resourceId: string) => ({
  moduleId: 'party.registry' as const,
  resourceId,
  resourceType: 'party.registry.party' as const,
  tenantId,
});

const relationshipRef = {
  moduleId: 'party.registry' as const,
  resourceId: relationshipId,
  resourceType: 'party.registry.party-relationship' as const,
  tenantId,
};

const canonicalEndpointReads = [[], [{ partyId: fromPartyId }], [], [{ partyId: toPartyId }]];

const relationshipRow = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  acceptedByActionInvocationId: actionInvocationId,
  acceptedByPrincipalId: principalId,
  assertionState: 'ACTIVE',
  endEvidenceReference: null,
  endProvenanceMethod: null,
  endProvenanceSource: null,
  endReason: null,
  endedByActionInvocationId: null,
  endedByPrincipalId: null,
  endedRecordedAt: null,
  fromPartyId,
  policyVersion: 'party.relationship.contact-person-of.v1',
  provenanceMethod: 'MANUAL_CONFIRMATION',
  provenanceSource: 'ENGAGEMENT_REVIEW',
  recordedAt: new Date('2026-01-01T00:00:00.000Z'),
  relationshipId,
  relationshipType: 'CONTACT_PERSON_OF',
  retractsRelationshipId: null,
  revision: 1,
  supersedesRelationshipId: null,
  tenantId,
  toPartyId,
  validFrom: null,
  validTo: null,
  ...overrides,
});

interface Harness {
  readonly insertValues: readonly Readonly<Record<string, unknown>>[];
  readonly transaction: Parameters<typeof createPartyRelationshipRecord>[0];
  readonly updateSets: readonly Readonly<Record<string, unknown>>[];
}

const transactionHarness = (
  selects: readonly (readonly Readonly<Record<string, unknown>>[])[],
  inserts: readonly (readonly Readonly<Record<string, unknown>>[])[] = [],
  updates: readonly (readonly Readonly<Record<string, unknown>>[])[] = [],
): Harness => {
  const selectQueue = [...selects];
  const insertQueue = [...inserts];
  const updateQueue = [...updates];
  const insertValues: Readonly<Record<string, unknown>>[] = [];
  const updateSets: Readonly<Record<string, unknown>>[] = [];
  const select = () => {
    const rows = selectQueue.shift() ?? [];
    const chain = {
      for: () => Promise.resolve(rows),
      from: () => chain,
      limit: () => chain,
      orderBy: () => chain,
      then: <Result>(
        onfulfilled?: ((value: readonly Readonly<Record<string, unknown>>[]) => Result) | null,
      ) => Promise.resolve(rows).then(onfulfilled),
      where: () => chain,
    };
    return chain;
  };
  const insert = () => {
    const rows = insertQueue.shift() ?? [];
    const chain = {
      returning: () => Promise.resolve(rows),
      values: (values: Readonly<Record<string, unknown>>) => {
        insertValues.push(values);
        return chain;
      },
    };
    return chain;
  };
  const update = () => {
    const rows = updateQueue.shift() ?? [];
    const chain = {
      returning: () => Promise.resolve(rows),
      set: (values: Readonly<Record<string, unknown>>) => {
        updateSets.push(values);
        return chain;
      },
      where: () => chain,
    };
    return chain;
  };
  // SAFETY: the harness implements precisely the select/insert/update fluent surface used here.
  const transaction = { insert, select, update } as unknown as Parameters<
    typeof createPartyRelationshipRecord
  >[0];
  return { insertValues, transaction, updateSets };
};

test('create persists an active assertion with unknown start and derives current state', async () => {
  const created = relationshipRow();
  const harness = transactionHarness(
    [
      [
        { archivedAt: null, currentType: 'PERSON', partyId: fromPartyId },
        { archivedAt: null, currentType: 'ORGANIZATION', partyId: toPartyId },
      ],
      ...canonicalEndpointReads,
      [],
    ],
    [[created]],
  );

  const result = await Effect.runPromise(
    createPartyRelationshipRecord(harness.transaction, tenantId, principalId, actionInvocationId, {
      fromPartyRef: ref(fromPartyId),
      provenance: { method: 'MANUAL_CONFIRMATION', source: 'ENGAGEMENT_REVIEW' },
      relationshipType: 'CONTACT_PERSON_OF',
      toPartyRef: ref(toPartyId),
      validFrom: null,
      validTo: null,
    }),
  );

  assert.equal(result.outcome, 'CREATED');
  assert.equal(result.relationship.state, 'CURRENT');
  assert.equal(harness.insertValues[0]?.['assertionState'], 'ACTIVE');
  assert.equal(harness.insertValues[0]?.['validFrom'], null);
  assert.equal('state' in (harness.insertValues[0] ?? {}), false);
  assert.equal('isCurrent' in (harness.insertValues[0] ?? {}), false);
});

test('update refines an unknown historical validFrom through the persistence service', async () => {
  const refinedAt = '2025-01-01T00:00:00.000Z';
  const validTo = new Date('2026-01-01T00:00:00.000Z');
  const current = relationshipRow({ validTo });
  const updated = relationshipRow({ revision: 2, validFrom: new Date(refinedAt), validTo });
  const harness = transactionHarness([[current], ...canonicalEndpointReads, []], [], [[updated]]);

  const result = await Effect.runPromise(
    updatePartyRelationshipRecord(harness.transaction, tenantId, principalId, actionInvocationId, {
      changeReason: 'Reliable engagement evidence established the relationship start',
      expectedRevision: 1,
      provenance: { method: 'DOCUMENT_REVIEW', source: 'ENGAGEMENT_RECORD' },
      relationshipRef,
      validFrom: refinedAt,
    }),
  );

  assert.equal(result.outcome, 'CHANGED');
  assert.equal(result.relationship.validFrom, refinedAt);
  assert.equal(result.relationship.state, 'HISTORICAL');
  assert.deepEqual(harness.updateSets[0]?.['validFrom'], new Date(refinedAt));
  assert.equal(harness.updateSets[0]?.['revision'], 2);
});

test('end keeps a future-ended relationship current and exposes bounded end history', async () => {
  const effectiveAt = '2099-01-01T00:00:00.000Z';
  const survivorId = '70000000-0000-4000-8000-000000000001';
  const current = relationshipRow({ validFrom: new Date('2025-01-01T00:00:00.000Z') });
  const ended = relationshipRow({
    endProvenanceMethod: 'MANUAL_CONFIRMATION',
    endProvenanceSource: 'ENGAGEMENT_REVIEW',
    endReason: 'A successor contact takes responsibility',
    endedByActionInvocationId: actionInvocationId,
    endedByPrincipalId: principalId,
    endedRecordedAt: new Date('2026-09-03T00:00:00.000Z'),
    revision: 2,
    validFrom: new Date('2025-01-01T00:00:00.000Z'),
    validTo: new Date(effectiveAt),
  });
  const harness = transactionHarness(
    [
      [current],
      [{ aliasPartyId: fromPartyId, canonicalPartyId: survivorId, tenantId }],
      [],
      [{ partyId: survivorId }],
      [],
      [{ partyId: toPartyId }],
    ],
    [],
    [[ended]],
  );

  const result = await Effect.runPromise(
    endPartyRelationshipRecord(harness.transaction, tenantId, principalId, actionInvocationId, {
      effectiveAt,
      expectedRevision: 1,
      provenance: { method: 'MANUAL_CONFIRMATION', source: 'ENGAGEMENT_REVIEW' },
      reason: 'A successor contact takes responsibility',
      relationshipRef,
    }),
  );

  assert.equal(result.relationship.state, 'CURRENT');
  assert.equal(result.relationship.from.canonicalPartyRef.resourceId, survivorId);
  assert.equal(result.relationship.from.storedPartyRef.resourceId, fromPartyId);
  assert.equal(result.relationship.endHistory.length, 1);
  assert.equal(result.relationship.endHistory[0]?.effectiveAt, effectiveAt);
  assert.equal(
    result.relationship.endHistory[0]?.reason,
    'A successor contact takes responsibility',
  );
  assert.equal('state' in (harness.updateSets[0] ?? {}), false);
  assert.equal('isCurrent' in (harness.updateSets[0] ?? {}), false);
});

test('detail derives scheduled state and resolves stored endpoint aliases independently', async () => {
  const canonicalFrom = '70000000-0000-4000-8000-000000000001';
  const middleAlias = '80000000-0000-4000-8000-000000000001';
  const scheduled = relationshipRow({ validFrom: new Date('2099-01-01T00:00:00.000Z') });
  const harness = transactionHarness([
    [scheduled],
    [{ aliasPartyId: fromPartyId, canonicalPartyId: middleAlias, tenantId }],
    [{ aliasPartyId: middleAlias, canonicalPartyId: canonicalFrom, tenantId }],
    [],
    [{ partyId: canonicalFrom }],
    [],
    [{ partyId: toPartyId }],
  ]);

  const detail = await Effect.runPromise(
    findPartyRelationshipRecord(harness.transaction, tenantId, relationshipId),
  );

  assert.equal(detail?.state, 'SCHEDULED');
  assert.equal(detail?.from.storedPartyRef.resourceId, fromPartyId);
  assert.equal(detail?.from.canonicalPartyRef.resourceId, canonicalFrom);
  assert.equal(detail?.from.requestedAlias?.resourceId, fromPartyId);
  assert.equal(detail?.to.requestedAlias, null);
});

test('non-active assertions never read as current even with an open effective interval', async () => {
  await Promise.all(
    ['RETRACTED', 'SUPERSEDED', 'DISPUTED'].map(async (assertionState) => {
      const harness = transactionHarness([
        [relationshipRow({ assertionState })],
        ...canonicalEndpointReads,
      ]);
      const detail = await Effect.runPromise(
        findPartyRelationshipRecord(harness.transaction, tenantId, relationshipId),
      );

      assert.equal(detail?.assertionState, assertionState);
      assert.equal(detail?.state, 'HISTORICAL');
    }),
  );
});

test('durable relationship update resolves alias-backed stored endpoints without rewriting them', async () => {
  const survivorId = '70000000-0000-4000-8000-000000000001';
  const updated = relationshipRow({
    revision: 2,
    validFrom: new Date('2099-01-01T00:00:00.000Z'),
  });
  const harness = transactionHarness(
    [
      [relationshipRow()],
      [{ aliasPartyId: fromPartyId, canonicalPartyId: survivorId, tenantId }],
      [],
      [{ partyId: survivorId }],
      [],
      [{ partyId: toPartyId }],
      [],
    ],
    [],
    [[updated]],
  );
  const result = await Effect.runPromise(
    updatePartyRelationshipRecord(harness.transaction, tenantId, principalId, actionInvocationId, {
      changeReason: 'A revised planned start',
      expectedRevision: 1,
      provenance: { method: 'MANUAL_CONFIRMATION', source: 'ENGAGEMENT_REVIEW' },
      relationshipRef,
      validFrom: '2099-01-01T00:00:00.000Z',
    }),
  );

  assert.equal(result.outcome, 'CHANGED');
  assert.equal(result.relationship.from.canonicalPartyRef.resourceId, survivorId);
  assert.equal(result.relationship.from.storedPartyRef.resourceId, fromPartyId);
  assert.equal('fromPartyId' in (harness.updateSets[0] ?? {}), false);
});

test('create rejects an explicit alias endpoint with canonical survivor guidance', async () => {
  const survivorId = '70000000-0000-4000-8000-000000000001';
  const harness = transactionHarness([
    [
      {
        archivedAt: new Date('2026-01-01T00:00:00.000Z'),
        currentType: 'PERSON',
        partyId: fromPartyId,
      },
      { archivedAt: null, currentType: 'ORGANIZATION', partyId: toPartyId },
    ],
    [{ aliasPartyId: fromPartyId, canonicalPartyId: survivorId, tenantId }],
    [],
    [{ partyId: survivorId }],
  ]);
  const rejection = await Effect.runPromise(
    createPartyRelationshipRecord(harness.transaction, tenantId, principalId, actionInvocationId, {
      fromPartyRef: ref(fromPartyId),
      provenance: { method: 'MANUAL_CONFIRMATION', source: 'ENGAGEMENT_REVIEW' },
      relationshipType: 'CONTACT_PERSON_OF',
      toPartyRef: ref(toPartyId),
      validFrom: null,
      validTo: null,
    }).pipe(Effect.flip),
  );

  assert.equal(rejection._tag, 'PartyAliasWriteRejected');
  if (rejection._tag === 'PartyAliasWriteRejected') {
    assert.equal(rejection.canonicalPartyRef.resourceId, survivorId);
  }
  assert.equal(harness.insertValues.length, 0);
});

test('a known historical start cannot be rewritten by ordinary update', async () => {
  const harness = transactionHarness([
    [relationshipRow({ validFrom: new Date('2025-01-01T00:00:00.000Z') })],
    ...canonicalEndpointReads,
  ]);
  const rejection = await Effect.runPromise(
    updatePartyRelationshipRecord(harness.transaction, tenantId, principalId, actionInvocationId, {
      changeReason: 'The previous start was wrong',
      expectedRevision: 1,
      provenance: { method: 'DOCUMENT_REVIEW', source: 'ENGAGEMENT_RECORD' },
      relationshipRef,
      validFrom: '2025-02-01T00:00:00.000Z',
    }).pipe(Effect.flip),
  );

  assert.equal(rejection._tag, 'PartyRelationshipCorrectionRequired');
  if (rejection._tag === 'PartyRelationshipCorrectionRequired') {
    assert.equal(rejection.fact, 'validFrom');
  }
  assert.equal(harness.updateSets.length, 0);
});

test('removing a future planned end clears its current evidence and retains prior audit detail', async () => {
  const current = relationshipRow({
    endProvenanceMethod: 'MANUAL_CONFIRMATION',
    endProvenanceSource: 'ENGAGEMENT_REVIEW',
    endReason: 'A planned contact handover',
    endedByActionInvocationId: actionInvocationId,
    endedByPrincipalId: principalId,
    endedRecordedAt: new Date('2026-01-01T00:00:00.000Z'),
    validTo: new Date('2099-01-01T00:00:00.000Z'),
  });
  const updated = relationshipRow({ revision: 2 });
  const harness = transactionHarness([[current], ...canonicalEndpointReads, []], [], [[updated]]);
  const result = await Effect.runPromise(
    updatePartyRelationshipRecord(harness.transaction, tenantId, principalId, actionInvocationId, {
      changeReason: 'The planned handover was canceled',
      expectedRevision: 1,
      provenance: { method: 'MANUAL_CONFIRMATION', source: 'ENGAGEMENT_REVIEW' },
      relationshipRef,
      validTo: null,
    }),
  );

  assert.equal(result.outcome, 'CHANGED');
  assert.equal(result.relationship.validTo, null);
  assert.deepEqual(result.relationship.endHistory, []);
  assert.equal(harness.updateSets[0]?.['endReason'], null);
  assert.equal(harness.updateSets[0]?.['endedRecordedAt'], null);
  if (result.outcome === 'CHANGED') {
    assert.equal(result.previous.endHistory[0]?.reason, 'A planned contact handover');
  }
});

test('update can shorten a future planned end to a valid retrospective end with new evidence', async () => {
  const validFrom = new Date('2025-01-01T00:00:00.000Z');
  const effectiveAt = '2026-02-01T00:00:00.000Z';
  const current = relationshipRow({ validFrom, validTo: new Date('2099-01-01T00:00:00.000Z') });
  const updated = relationshipRow({
    endProvenanceMethod: 'DOCUMENT_REVIEW',
    endProvenanceSource: 'ENGAGEMENT_RECORD',
    endReason: 'The handover actually completed earlier',
    endedByActionInvocationId: actionInvocationId,
    endedByPrincipalId: principalId,
    endedRecordedAt: new Date('2026-09-03T00:00:00.000Z'),
    revision: 2,
    validFrom,
    validTo: new Date(effectiveAt),
  });
  const harness = transactionHarness([[current], ...canonicalEndpointReads, []], [], [[updated]]);
  const result = await Effect.runPromise(
    updatePartyRelationshipRecord(harness.transaction, tenantId, principalId, actionInvocationId, {
      changeReason: 'The handover actually completed earlier',
      expectedRevision: 1,
      provenance: { method: 'DOCUMENT_REVIEW', source: 'ENGAGEMENT_RECORD' },
      relationshipRef,
      validTo: effectiveAt,
    }),
  );

  assert.equal(result.outcome, 'CHANGED');
  assert.equal(result.relationship.state, 'HISTORICAL');
  assert.equal(result.relationship.endHistory[0]?.effectiveAt, effectiveAt);
  assert.equal(harness.updateSets[0]?.['endProvenanceSource'], 'ENGAGEMENT_RECORD');
  assert.equal(harness.updateSets[0]?.['endedByActionInvocationId'], actionInvocationId);
});

test('an evidence-backed end without a generic reason stays visible and retries exactly', async () => {
  const effectiveAt = '2026-02-01T00:00:00.000Z';
  const ended = relationshipRow({
    endProvenanceMethod: 'DOCUMENT_REVIEW',
    endProvenanceSource: 'ENGAGEMENT_RECORD',
    endedByActionInvocationId: actionInvocationId,
    endedByPrincipalId: principalId,
    endedRecordedAt: new Date('2026-09-03T00:00:00.000Z'),
    revision: 2,
    validTo: new Date(effectiveAt),
  });
  const harness = transactionHarness(
    [[relationshipRow()], ...canonicalEndpointReads],
    [],
    [[ended]],
  );
  const payload = {
    effectiveAt,
    expectedRevision: 1,
    provenance: { method: 'DOCUMENT_REVIEW', source: 'ENGAGEMENT_RECORD' },
    relationshipRef,
  };
  const result = await Effect.runPromise(
    endPartyRelationshipRecord(
      harness.transaction,
      tenantId,
      principalId,
      actionInvocationId,
      payload,
    ),
  );
  assert.equal(result.relationship.endHistory.length, 1);
  assert.equal(result.relationship.endHistory[0]?.reason, null);
  assert.equal(harness.updateSets[0]?.['endReason'], null);

  const retryHarness = transactionHarness([[ended], ...canonicalEndpointReads]);
  const retry = await Effect.runPromise(
    endPartyRelationshipRecord(
      retryHarness.transaction,
      tenantId,
      principalId,
      actionInvocationId,
      {
        ...payload,
        expectedRevision: 2,
      },
    ),
  );
  assert.equal(retry.outcome, 'UNCHANGED');
  assert.equal(retryHarness.updateSets.length, 0);
});
