// @effect-diagnostics asyncFunction:off globalDate:off
/* eslint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type, unicorn/no-thenable -- This harness implements the correction service's Drizzle boundary. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import {
  PartyCorrectionCommandSchema,
  PartyCorrectionDetailSchema,
  classifyCorrectionRoute,
} from '../../shared/domain/correction-contracts.ts';
import { confirmDuplicatePartiesAction } from '../../src/actions/confirm-duplicate-parties.action.ts';
import { correctPartyFactAction } from '../../src/actions/correct-party-fact.action.ts';
import { partyCorrectionPermissionTarget } from '../../src/api/party-correction.read.ts';
import {
  correctPartyFactRecord,
  encodeStoredCorrectionReason,
  findPartyCorrection,
} from '../../src/services/party-correction.service.ts';

const decode = Schema.decodeUnknownSync;
const evidence = {
  evidenceRefs: ['evidence:1'],
  evidenceSource: 'DOCUMENT',
  policyVersion: 'party-correction.v1',
  provenance: { method: 'DOCUMENT_REVIEW', source: 'SIGNED_RECORD' },
  reasonCode: 'WRONG_IDENTITY_VALUE',
  reasonDetail: 'The accepted assertion was wrong at assertion time.',
} as const;
const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '20000000-0000-4000-8000-000000000001';
const organizationId = '30000000-0000-4000-8000-000000000001';
const assertionId = '40000000-0000-4000-8000-000000000001';
const replacementId = '50000000-0000-4000-8000-000000000001';
const correctionId = '60000000-0000-4000-8000-000000000001';
const principalId = '70000000-0000-4000-8000-000000000001';
const actionInvocationId = '80000000-0000-4000-8000-000000000001';
const relationshipRef = {
  moduleId: 'party.registry',
  resourceId: assertionId,
  resourceType: 'party.registry.party-relationship',
  tenantId,
} as const;
const relationshipCommand = {
  ...evidence,
  correctionMode: 'SUPERSEDE',
  expectedRevision: 1,
  factKind: 'RELATIONSHIP',
  relationshipRef,
  replacementValidFrom: null,
  replacementValidTo: '2026-02-01T00:00:00.000Z',
} as const;

test('correction is closed to Party type, display name, and official identifier assertions', () => {
  for (const factKind of ['PARTY_TYPE', 'DISPLAY_NAME', 'OFFICIAL_IDENTIFIER']) {
    assert.doesNotThrow(() =>
      decode(PartyCorrectionCommandSchema)({
        ...evidence,
        factKind,
        partyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        policyVersion: 'party-correction.v1',
        replacementValue: factKind === 'PARTY_TYPE' ? 'PERSON' : 'replacement',
        targetAssertionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
    );
  }
  assert.throws(() =>
    decode(PartyCorrectionCommandSchema)({
      ...evidence,
      factKind: 'CONTACT_POINT',
      partyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      policyVersion: 'party-correction.v1',
      replacementValue: 'x',
      targetAssertionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }),
  );
});

test('correction follow-up is typed and duplicate confirmation remains readiness-only', () => {
  assert.equal(classifyCorrectionRoute('PARTY_TYPE'), 'LIFECYCLE_REVIEW');
  assert.equal(classifyCorrectionRoute('DISPLAY_NAME'), 'ENRICHMENT_REVIEW');
  assert.equal(classifyCorrectionRoute('OFFICIAL_IDENTIFIER'), 'CLAIM_REASSIGNMENT_REVIEW');
  assert.equal(classifyCorrectionRoute('RELATIONSHIP'), 'RELATIONSHIP_REVIEW');
  assert.equal(
    confirmDuplicatePartiesAction.descriptor.actionKey,
    'party.registry.confirm-duplicate-parties',
  );
  assert.equal(
    Object.hasOwn(
      confirmDuplicatePartiesAction.descriptor.domainEvents,
      'party.registry.party-merged.v1',
    ),
    false,
  );
  assert.equal(
    correctPartyFactAction.descriptor.tenantPermission?.({
      ...evidence,
      factKind: 'PARTY_TYPE',
      partyId,
      replacementValue: 'PERSON',
      subjectEvidence: [
        {
          basis: 'REVIEWED_DOCUMENT',
          evidenceRef: 'record/42',
          kind: 'ACTOR_ATTESTATION',
          observedSubject: 'PERSON',
          statement: 'Reviewed this external organization',
          subjectKey: 'one-subject',
        },
      ],
      targetAssertionId: assertionId,
    }),
    'manage_party_identity',
  );
  assert.equal(correctPartyFactAction.descriptor.auditProfile, 'sensitive');
  assert.equal(
    correctPartyFactAction.descriptor.tenantPermission?.(relationshipCommand),
    'manage_party_relationships',
  );
});

test('relationship correction is closed, revisioned, interval checked, and has no caller authority hints', () => {
  const strictDecode = Schema.decodeUnknownSync(PartyCorrectionCommandSchema, {
    onExcessProperty: 'error',
  });
  assert.deepEqual(strictDecode(relationshipCommand), relationshipCommand);
  assert.throws(() => strictDecode({ ...relationshipCommand, reasonCode: 'OTHER' }));
  assert.throws(() => strictDecode({ ...relationshipCommand, expectedRevision: 0 }));
  assert.throws(() =>
    strictDecode({ ...relationshipCommand, replacementValidFrom: '2026-03-01T00:00:00.000Z' }),
  );
  for (const field of [
    'fromPartyRef',
    'toPartyRef',
    'relationshipType',
    'tenantPermission',
    'actingPrincipalId',
    'approvingPrincipalId',
  ]) {
    assert.throws(() => strictDecode({ ...relationshipCommand, [field]: 'caller-controlled' }));
  }
});

const relationshipRow = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  assertionState: 'ACTIVE',
  endProvenanceMethod: null,
  endProvenanceSource: null,
  endReason: null,
  endedRecordedAt: null,
  fromPartyId: partyId,
  provenanceMethod: 'DECLARED',
  provenanceSource: 'USER',
  recordedAt: new Date('2026-01-01T00:00:00.000Z'),
  relationshipId: assertionId,
  relationshipType: 'CONTACT_PERSON_OF',
  revision: 1,
  tenantId,
  toPartyId: organizationId,
  validFrom: null,
  validTo: null,
  ...overrides,
});

const transactionHarness = (
  selects: readonly (readonly Readonly<Record<string, unknown>>[])[],
  inserts: readonly (readonly Readonly<Record<string, unknown>>[])[] = [],
  updates: readonly (readonly Readonly<Record<string, unknown>>[])[] = [],
  insertFailure?: { readonly cause: { readonly code: string; readonly constraint: string } },
) => {
  const selectQueue = [...selects];
  const insertQueue = [...inserts];
  const updateQueue = [...updates];
  const insertValues: Readonly<Record<string, unknown>>[] = [];
  const updateSets: Readonly<Record<string, unknown>>[] = [];
  const chain = (rows: readonly Readonly<Record<string, unknown>>[]) => {
    const value = {
      for: () => Promise.resolve(rows),
      from: () => value,
      limit: () => value,
      returning: () => Promise.resolve(rows),
      set: (set: Readonly<Record<string, unknown>>) => {
        updateSets.push(set);
        return value;
      },
      then: <Result>(
        onfulfilled?: ((result: readonly Readonly<Record<string, unknown>>[]) => Result) | null,
      ) => Promise.resolve(rows).then(onfulfilled),
      values: (insert: Readonly<Record<string, unknown>>) => {
        insertValues.push(insert);
        return value;
      },
      where: () => value,
    };
    return value;
  };
  // SAFETY: The harness implements exactly the select/insert/update fluent surface used by these cases.
  const transaction = {
    insert: () => {
      const query = chain(insertQueue.shift() ?? []);
      return insertFailure === undefined
        ? query
        : {
            ...query,
            values: (insert: Readonly<Record<string, unknown>>) => {
              insertValues.push(insert);
              return { returning: () => Promise.reject(insertFailure) };
            },
          };
    },
    select: () => chain(selectQueue.shift() ?? []),
    update: () => chain(updateQueue.shift() ?? []),
  } as unknown as Parameters<typeof correctPartyFactRecord>[0];
  return { insertValues, transaction, updateSets };
};

test('relationship supersession preserves endpoint/type identity and stores trusted actor plus old/new links', async () => {
  const original = relationshipRow();
  const replacement = relationshipRow({ relationshipId: replacementId });
  const h = transactionHarness(
    [[], [original], [], [{ partyId }], [], [{ partyId: organizationId }]],
    [[replacement], [{ correctionId }]],
    [[original]],
  );
  const result = await Effect.runPromise(
    correctPartyFactRecord(h.transaction, tenantId, relationshipCommand, {
      actionInvocationId,
      principalId,
    }),
  );
  assert.deepEqual(h.updateSets[0], { assertionState: 'SUPERSEDED', revision: 2 });
  assert.equal(h.insertValues[0]?.['fromPartyId'], partyId);
  assert.equal(h.insertValues[0]?.['toPartyId'], organizationId);
  assert.equal(h.insertValues[0]?.['relationshipType'], 'CONTACT_PERSON_OF');
  assert.equal(h.insertValues[0]?.['supersedesRelationshipId'], assertionId);
  assert.equal(h.insertValues[0]?.['validFrom'], null);
  assert.equal(h.insertValues[1]?.['actingPrincipalId'], principalId);
  assert.equal(h.insertValues[1]?.['relationshipId'], assertionId);
  assert.equal(h.insertValues[1]?.['replacementRelationshipId'], replacementId);
  assert.equal(Object.hasOwn(h.insertValues[1] ?? {}, 'approvingPrincipalId'), false);
  assert.equal(result.relationshipRef?.resourceId, assertionId);
  assert.equal(result.replacementRelationshipRef?.resourceId, replacementId);
});

test('relationship retraction retains original effective validity and creates no replacement', async () => {
  const command = decode(PartyCorrectionCommandSchema)({
    ...evidence,
    correctionMode: 'RETRACT',
    expectedRevision: 1,
    factKind: 'RELATIONSHIP',
    relationshipRef,
  });
  const original = relationshipRow({ validFrom: new Date('2025-01-01T00:00:00.000Z') });
  const h = transactionHarness(
    [[], [original], [], [{ partyId }], [], [{ partyId: organizationId }]],
    [[{ correctionId }]],
    [[original]],
  );
  const result = await Effect.runPromise(
    correctPartyFactRecord(h.transaction, tenantId, command, { actionInvocationId, principalId }),
  );
  assert.deepEqual(h.updateSets[0], { assertionState: 'RETRACTED', revision: 2 });
  assert.equal(h.insertValues.length, 1);
  assert.equal(result.replacementAssertionId, null);
});

test('stale revision and foreign-tenant relationship correction fail before business writes', async () => {
  await Promise.all(
    [
      { ...relationshipCommand, expectedRevision: 2 },
      { ...relationshipCommand, relationshipRef: { ...relationshipRef, tenantId: organizationId } },
    ].map(async (command) => {
      const h = transactionHarness([[], [relationshipRow()]]);
      const error = await Effect.runPromise(
        Effect.flip(
          correctPartyFactRecord(h.transaction, tenantId, command, {
            actionInvocationId,
            principalId,
          }),
        ),
      );
      assert.equal(error._tag, 'PartyCorrectionConflict');
      assert.equal(h.updateSets.length, 0);
      assert.equal(h.insertValues.length, 0);
    }),
  );
});

test('UNRESOLVED Party Type enrichment is rejected before mutation by correction', async () => {
  const h = transactionHarness([
    [],
    [{ partyId }],
    [],
    [{ partyId }],
    [
      {
        assertionId,
        factKind: 'PARTY_TYPE',
        isCurrent: true,
        normalizedValue: 'UNRESOLVED',
        partyId,
        state: 'ACTIVE',
      },
    ],
  ]);
  const command = {
    ...evidence,
    factKind: 'PARTY_TYPE',
    partyId,
    replacementValue: 'PERSON',
    subjectEvidence: [
      {
        basis: 'REVIEWED_DOCUMENT',
        evidenceRef: 'record/42',
        kind: 'ACTOR_ATTESTATION',
        observedSubject: 'PERSON',
        statement: 'Reviewed this external organization',
        subjectKey: 'one-subject',
      },
    ],
    targetAssertionId: assertionId,
  } as const;
  const error = await Effect.runPromise(
    Effect.flip(
      correctPartyFactRecord(h.transaction, tenantId, command, { actionInvocationId, principalId }),
    ),
  );
  assert.equal(error._tag, 'PartyCorrectionConflict');
  assert.match(error.reason, /enrichment/u);
  assert.equal(h.updateSets.length, 0);
});

test('detail exposes immutable original/result semantics, governance, and source distinct from actor', async () => {
  const h = transactionHarness([
    [
      {
        actingPrincipalId: principalId,
        actionInvocationId,
        approvingPrincipalId: null,
        correctionId,
        evidenceRefs: evidence.evidenceRefs,
        officialIdentifierId: null,
        partyFactAssertionId: null,
        partyId,
        policyVersion: evidence.policyVersion,
        reason: encodeStoredCorrectionReason(relationshipCommand),
        recordedAt: new Date('2026-09-03T00:00:00.000Z'),
        relationshipId: assertionId,
        replacementOfficialIdentifierId: null,
        replacementPartyFactAssertionId: null,
        replacementRelationshipId: replacementId,
      },
    ],
    [
      relationshipRow({
        assertionState: 'SUPERSEDED',
        endProvenanceMethod: 'DOCUMENT_REVIEW',
        endProvenanceSource: 'ORIGINAL_END_RECORD',
        endReason: null,
        endedRecordedAt: new Date('2026-01-16T00:00:00.000Z'),
        validTo: new Date('2026-01-15T00:00:00.000Z'),
      }),
    ],
    [
      relationshipRow({
        relationshipId: replacementId,
        validTo: new Date(relationshipCommand.replacementValidTo),
      }),
    ],
  ]);
  const found = await Effect.runPromise(findPartyCorrection(h.transaction, tenantId, correctionId));
  assert.equal(found._tag, 'found');
  if (found._tag !== 'found') {
    return;
  }
  const detail = decode(PartyCorrectionDetailSchema)(found.value);
  assert.equal(detail.actingPrincipalId, principalId);
  assert.equal(detail.approvingPrincipalId, null);
  assert.equal(detail.evidenceSource, 'DOCUMENT');
  assert.equal(detail.actionInvocationId, actionInvocationId);
  assert.equal(detail.originalAssertion.assertionId, assertionId);
  assert.equal(detail.originalAssertion.validTo, '2026-01-15T00:00:00.000Z');
  assert.equal(detail.originalAssertion.factKind, 'RELATIONSHIP');
  if (detail.originalAssertion.factKind === 'RELATIONSHIP') {
    assert.equal(detail.originalAssertion.endEvidence?.reason, null);
    assert.equal(detail.originalAssertion.endEvidence?.provenance.source, 'ORIGINAL_END_RECORD');
    assert.equal(detail.originalAssertion.endEvidence?.recordedAt, '2026-01-16T00:00:00.000Z');
  }
  assert.equal(detail.resultingAssertion?.assertionId, replacementId);
  assert.equal(detail.resultingAssertion?.validTo, relationshipCommand.replacementValidTo);
  assert.equal(detail.governance.legalHolds, 'HONOR_GOVERNED_LEGAL_HOLDS');
  assert.equal(detail.governance.policyVersion, detail.policyVersion);
});

test('relationship overlap is a typed conflict and no correction journal is written after failed replacement', async () => {
  const original = relationshipRow();
  const h = transactionHarness(
    [[], [original], [], [{ partyId }], [], [{ partyId: organizationId }]],
    [],
    [[original]],
    { cause: { code: '23P01', constraint: 'party_relationships_no_overlap_excl' } },
  );
  const error = await Effect.runPromise(
    Effect.flip(
      correctPartyFactRecord(h.transaction, tenantId, relationshipCommand, {
        actionInvocationId,
        principalId,
      }),
    ),
  );
  assert.equal(error._tag, 'PartyCorrectionConflict');
  assert.match(error.reason, /overlaps/u);
  assert.equal(h.insertValues.length, 1);
  // The failed Effect leaves the enclosing Core transaction to roll back the original transition.
  assert.equal(h.insertValues[0]?.['supersedesRelationshipId'], assertionId);
});

test('correction of a durable relationship preserves stored alias endpoints', async () => {
  const canonicalId = '90000000-0000-4000-8000-000000000001';
  const original = relationshipRow();
  const h = transactionHarness(
    [
      [],
      [original],
      [{ aliasPartyId: partyId, canonicalPartyId: canonicalId, tenantId }],
      [],
      [{ partyId: canonicalId }],
      [],
      [{ partyId: organizationId }],
    ],
    [[relationshipRow({ relationshipId: replacementId })], [{ correctionId }]],
    [[original]],
  );
  await Effect.runPromise(
    correctPartyFactRecord(h.transaction, tenantId, relationshipCommand, {
      actionInvocationId,
      principalId,
    }),
  );
  assert.equal(h.insertValues[0]?.['fromPartyId'], partyId);
  assert.notEqual(h.insertValues[0]?.['fromPartyId'], canonicalId);
});

test('correction history requires reviewer authority; ordinary identity read permission is insufficient', () => {
  const target = partyCorrectionPermissionTarget();
  assert.deepEqual(target, { kind: 'tenant', permission: 'review_party_identity' });
  assert.notDeepEqual(target, { kind: 'tenant', permission: 'read_party_identity' });
});

test('Party Type correction reconciles newly eligible claims before superseding the original fact', async () => {
  const h = transactionHarness([
    [],
    [{ partyId }],
    [],
    [{ partyId }],
    [
      {
        assertionId,
        factKind: 'PARTY_TYPE',
        isCurrent: true,
        normalizedValue: 'PERSON',
        partyId,
        state: 'ACTIVE',
      },
    ],
    [],
    [
      {
        identifierTypeKey: 'ICO',
        namespace: 'CZ:ICO',
        normalizedValue: '27074358',
        officialIdentifierId: replacementId,
        verificationState: 'VERIFIED',
      },
    ],
    [],
    [{ partyId: organizationId }],
  ]);
  const command = {
    ...evidence,
    factKind: 'PARTY_TYPE',
    partyId,
    replacementValue: 'ORGANIZATION',
    subjectEvidence: [
      {
        basis: 'REVIEWED_DOCUMENT',
        evidenceRef: 'record/42',
        kind: 'ACTOR_ATTESTATION',
        observedSubject: 'ORGANIZATION',
        statement: 'Reviewed this external organization',
        subjectKey: 'one-subject',
      },
    ],
    targetAssertionId: assertionId,
  } as const;
  const error = await Effect.runPromise(
    Effect.flip(
      correctPartyFactRecord(h.transaction, tenantId, command, { actionInvocationId, principalId }),
    ),
  );
  assert.equal(error._tag, 'PartyCorrectionConflict');
  assert.match(error.reason, /exclusive identifier claims/u);
  assert.equal(h.updateSets.length, 0);
  assert.equal(h.insertValues.length, 0);
});

test('type Correction cannot treat a reviewer decision or source label as subject evidence', async () => {
  const h = transactionHarness([
    [],
    [{ partyId }],
    [],
    [{ partyId }],
    [
      {
        assertionId,
        factKind: 'PARTY_TYPE',
        isCurrent: true,
        normalizedValue: 'PERSON',
        partyId,
        state: 'ACTIVE',
      },
    ],
  ]);
  const command = {
    ...evidence,
    factKind: 'PARTY_TYPE',
    partyId,
    replacementValue: 'ORGANIZATION',
    targetAssertionId: assertionId,
  } as const;
  const error = await Effect.runPromise(
    Effect.flip(
      correctPartyFactRecord(h.transaction, tenantId, command, { actionInvocationId, principalId }),
    ),
  );
  assert.equal(error._tag, 'PartyCorrectionConflict');
  assert.equal(error.reason, 'subject_evidence_required');
  assert.equal(h.insertValues.length, 0);
  assert.equal(h.updateSets.length, 0);
});
