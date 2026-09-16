/* eslint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type -- This harness implements the correction service's Drizzle boundary. expires: 2026-12-31. */
import { DateTime, Effect, Match, Option, Schema, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  PartyCorrectionCommandSchema,
  PartyCorrectionDetailSchema,
  PartyCorrectionConflict,
  SupersedeRelationshipCorrectionCommandSchema,
  classifyCorrectionRoute,
} from '../../shared/domain/correction-contracts.ts';
import { PartyCommandConflictProblemSchema } from '../../shared/command-api.ts';
import { confirmDuplicatePartiesAction } from '../../src/actions/confirm-duplicate-parties.action.ts';
import { correctPartyFactAction } from '../../src/actions/correct-party-fact.action.ts';
import { partyCorrectionPermissionTarget } from '../../src/api/party-correction.read.ts';
import { mapPartyActionProblem } from '../../api/party-command-problems.ts';
import {
  correctPartyFactRecord,
  encodeStoredCorrectionReason,
  findPartyCorrection,
} from '../../src/services/party-correction.service.ts';
import { partyRelationshipRef } from '../../shared/domain/relationship-contract.ts';

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
const relationshipCommandEncoded = {
  ...evidence,
  correctionMode: 'SUPERSEDE',
  expectedRevision: 1,
  factKind: 'RELATIONSHIP',
  relationshipRef,
  replacementValidFrom: null,
  replacementValidTo: '2026-02-01T00:00:00.000Z',
} as const;
const relationshipCommand = Schema.decodeSync(SupersedeRelationshipCorrectionCommandSchema)(relationshipCommandEncoded);
it('correction is closed to Party type, display name, and official identifier assertions', () => {
  for (const factKind of ['PARTY_TYPE', 'DISPLAY_NAME', 'OFFICIAL_IDENTIFIER']) {
    expect(() =>
      decode(PartyCorrectionCommandSchema)({
        ...evidence,
        factKind,
        partyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        policyVersion: 'party-correction.v1',
        replacementValue: factKind === 'PARTY_TYPE' ? 'PERSON' : 'replacement',
        targetAssertionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
    ).not.toThrow();
  }
  expect(() =>
    decode(PartyCorrectionCommandSchema)({
      ...evidence,
      factKind: 'CONTACT_POINT',
      partyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      policyVersion: 'party-correction.v1',
      replacementValue: 'x',
      targetAssertionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }),
  ).toThrow();
});
it('correction follow-up is typed and duplicate confirmation remains readiness-only', () => {
  expect(classifyCorrectionRoute('PARTY_TYPE')).toBe('LIFECYCLE_REVIEW');
  expect(classifyCorrectionRoute('DISPLAY_NAME')).toBe('ENRICHMENT_REVIEW');
  expect(classifyCorrectionRoute('OFFICIAL_IDENTIFIER')).toBe('CLAIM_REASSIGNMENT_REVIEW');
  expect(classifyCorrectionRoute('RELATIONSHIP')).toBe('RELATIONSHIP_REVIEW');
  expect(confirmDuplicatePartiesAction.descriptor.actionKey).toBe('party.registry.confirm-duplicate-parties');
  expect(Object.hasOwn(confirmDuplicatePartiesAction.descriptor.domainEvents, 'party.registry.party-merged.v1')).toBe(
    false,
  );
  const partyTypeCommand = Schema.decodeSync(PartyCorrectionCommandSchema)({
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
  });
  expect(correctPartyFactAction.descriptor.tenantPermission?.(partyTypeCommand)).toBe('manage_party_identity');
  expect(correctPartyFactAction.descriptor.auditProfile).toBe('sensitive');
  expect(correctPartyFactAction.descriptor.tenantPermission?.(relationshipCommand)).toBe('manage_party_relationships');
});

it('public correction conflicts preserve bounded relationship prerequisites in the 409 contract', () => {
  const refs = [partyRelationshipRef(tenantId, '91000000-0000-4000-8000-000000000001')];
  const problem = mapPartyActionProblem(
    new PartyCorrectionConflict({
      code: 'party_correction_conflict',
      conflictingRelationshipRefs: refs,
      reason: 'The corrected Party Type conflicts with active Party Relationships',
    }),
  );
  expect(Schema.is(PartyCommandConflictProblemSchema)(problem)).toBe(true);
  if (!Schema.is(PartyCommandConflictProblemSchema)(problem)) {
    expect.unreachable('Expected a PartyCommandConflictProblem');
  }
  expect(problem.code).toBe('party_correction_conflict');
  expect(problem.conflictingRelationshipRefs).toEqual(refs);
  expect(Schema.is(PartyCommandConflictProblemSchema)(problem)).toBe(true);
});
it('relationship correction is closed, revisioned, interval checked, and has no caller authority hints', () => {
  const strictDecode = Schema.decodeUnknownSync(PartyCorrectionCommandSchema, {
    onExcessProperty: 'error',
  });
  const decoded = strictDecode(relationshipCommandEncoded);
  expect(Schema.encodeSync(PartyCorrectionCommandSchema)(decoded)).toEqual(relationshipCommandEncoded);
  expect(() => strictDecode({ ...relationshipCommandEncoded, reasonCode: 'OTHER' })).toThrow();
  expect(() => strictDecode({ ...relationshipCommandEncoded, expectedRevision: 0 })).toThrow();
  expect(() =>
    strictDecode({
      ...relationshipCommandEncoded,
      replacementValidFrom: '2026-03-01T00:00:00.000Z',
    }),
  ).toThrow();
  for (const field of [
    'fromPartyRef',
    'toPartyRef',
    'relationshipType',
    'tenantPermission',
    'actingPrincipalId',
    'approvingPrincipalId',
  ]) {
    expect(() =>
      strictDecode({
        ...relationshipCommandEncoded,
        [field]: 'caller-controlled',
      }),
    ).toThrow();
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
  recordedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00.000Z')),
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
  insertFailure?: {
    readonly cause: {
      readonly code: string;
      readonly constraint: string;
    };
  },
) => {
  const selectQueue = [...selects];
  const insertQueue = [...inserts];
  const updateQueue = [...updates];
  const insertValues: Readonly<Record<string, unknown>>[] = [];
  const updateSets: Readonly<Record<string, unknown>>[] = [];
  const chain = (rows: readonly Readonly<Record<string, unknown>>[]) => {
    const value = Object.assign(
      Effect.sync(() => rows),
      {
        for: () => Effect.succeed(rows),
        from: () => value,
        limit: () => value,
        orderBy: () => value,
        returning: () => Effect.succeed(rows),
        set: (set: Readonly<Record<string, unknown>>) => {
          updateSets.push(set);
          return value;
        },
        values: (insert: Readonly<Record<string, unknown>>) => {
          insertValues.push(insert);
          return value;
        },
        where: () => value,
      },
    );
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
              return { returning: () => Effect.fail(insertFailure) };
            },
          };
    },
    select: () => chain(selectQueue.shift() ?? []),
    update: () => chain(updateQueue.shift() ?? []),
  } as unknown as Parameters<typeof correctPartyFactRecord>[0];
  return { insertValues, transaction, updateSets };
};
it.effect(
  'relationship supersession preserves endpoint/type identity and stores trusted actor plus old/new links',
  () =>
    Effect.gen(function* correctionScenario1() {
      const original = relationshipRow();
      const replacement = relationshipRow({ relationshipId: replacementId });
      const h = transactionHarness(
        [[], [original], [], [{ partyId }], [], [{ partyId: organizationId }]],
        [[replacement], [{ correctionId }]],
        [[original]],
      );
      const result = yield* correctPartyFactRecord(h.transaction, tenantId, relationshipCommand, {
        actionInvocationId,
        principalId,
      });
      expect(h.updateSets[0]).toEqual({
        assertionState: 'SUPERSEDED',
        revision: 2,
      });
      expect(h.insertValues[0]?.['fromPartyId']).toBe(partyId);
      expect(h.insertValues[0]?.['toPartyId']).toBe(organizationId);
      expect(h.insertValues[0]?.['relationshipType']).toBe('CONTACT_PERSON_OF');
      expect(h.insertValues[0]?.['supersedesRelationshipId']).toBe(assertionId);
      expect(h.insertValues[0]?.['validFrom']).toBe(null);
      expect(h.insertValues[1]?.['actingPrincipalId']).toBe(principalId);
      expect(h.insertValues[1]?.['relationshipId']).toBe(assertionId);
      expect(h.insertValues[1]?.['replacementRelationshipId']).toBe(replacementId);
      expect(Object.hasOwn(h.insertValues[1] ?? {}, 'approvingPrincipalId')).toBe(false);
      expect(Option.getOrThrow(result.relationshipRef).resourceId).toBe(assertionId);
      expect(Option.getOrThrow(result.replacementRelationshipRef).resourceId).toBe(replacementId);
    }),
);
it.effect('relationship retraction retains original effective validity and creates no replacement', () =>
  Effect.gen(function* correctionScenario2() {
    const command = yield* Schema.decodeEffect(PartyCorrectionCommandSchema)({
      ...evidence,
      correctionMode: 'RETRACT',
      expectedRevision: 1,
      factKind: 'RELATIONSHIP',
      relationshipRef,
    });
    const original = relationshipRow({
      validFrom: DateTime.toDateUtc(DateTime.makeUnsafe('2025-01-01T00:00:00.000Z')),
    });
    const h = transactionHarness(
      [[], [original], [], [{ partyId }], [], [{ partyId: organizationId }]],
      [[{ correctionId }]],
      [[original]],
    );
    const result = yield* correctPartyFactRecord(h.transaction, tenantId, command, {
      actionInvocationId,
      principalId,
    });
    expect(h.updateSets[0]).toEqual({
      assertionState: 'RETRACTED',
      revision: 2,
    });
    expect(h.insertValues.length).toBe(1);
    expect(Option.isNone(result.replacementAssertionId)).toBe(true);
  }),
);
it.effect('stale revision and foreign-tenant relationship correction fail before business writes', () =>
  Effect.forEach(
    [
      Schema.decodeSync(SupersedeRelationshipCorrectionCommandSchema)({
        ...relationshipCommandEncoded,
        expectedRevision: 2,
      }),
      Schema.decodeSync(SupersedeRelationshipCorrectionCommandSchema)({
        ...relationshipCommandEncoded,
        relationshipRef: { ...relationshipRef, tenantId: organizationId },
      }),
    ],
    (command) =>
      Effect.gen(function* correctionScenario4() {
        const h = transactionHarness([[], [relationshipRow()]]);
        const error = yield* Effect.flip(
          correctPartyFactRecord(h.transaction, tenantId, command, {
            actionInvocationId,
            principalId,
          }),
        );
        expect(Predicate.isTagged(error, 'PartyCorrectionConflict')).toBe(true);
        expect(h.updateSets.length).toBe(0);
        expect(h.insertValues.length).toBe(0);
      }),
    { concurrency: 1 },
  ),
);
it.effect('detail exposes immutable original/result semantics, governance, and source distinct from actor', () =>
  Effect.gen(function* correctionScenario6() {
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
          recordedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-03T00:00:00.000Z')),
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
          endedRecordedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-16T00:00:00.000Z')),
          validTo: DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-15T00:00:00.000Z')),
        }),
      ],
      [
        relationshipRow({
          relationshipId: replacementId,
          validTo: DateTime.toDateUtc(DateTime.makeUnsafe(relationshipCommandEncoded.replacementValidTo)),
        }),
      ],
    ]);
    const found = yield* findPartyCorrection(h.transaction, tenantId, correctionId);
    const detail = Match.value(found).pipe(
      Match.tag('found', ({ value }) => Schema.encodeSync(PartyCorrectionDetailSchema)(value)),
      Match.tag('not_found', () => expect.unreachable('Expected the correction detail to be found')),
      Match.exhaustive,
    );
    expect(
      yield* Schema.encodeEffect(PartyCorrectionDetailSchema)(
        yield* Schema.decodeEffect(PartyCorrectionDetailSchema)(detail),
      ),
    ).toEqual(detail);
    expect(detail.actingPrincipalId).toBe(principalId);
    expect(detail.approvingPrincipalId).toBe(null);
    expect(detail.evidenceSource).toBe('DOCUMENT');
    expect(detail.actionInvocationId).toBe(actionInvocationId);
    expect(detail.originalAssertion.assertionId).toBe(assertionId);
    expect(detail.originalAssertion.validTo).toBe('2026-01-15T00:00:00.000Z');
    expect(detail.originalAssertion.factKind).toBe('RELATIONSHIP');
    if (detail.originalAssertion.factKind === 'RELATIONSHIP') {
      expect(detail.originalAssertion.endEvidence?.reason).toBe(null);
      expect(detail.originalAssertion.endEvidence?.provenance.source).toBe('ORIGINAL_END_RECORD');
      expect(detail.originalAssertion.endEvidence?.recordedAt).toBe('2026-01-16T00:00:00.000Z');
    }
    expect(detail.resultingAssertion?.assertionId).toBe(replacementId);
    expect(detail.resultingAssertion?.validTo).toBe(relationshipCommandEncoded.replacementValidTo);
    expect(detail.governance.legalHolds).toBe('HONOR_GOVERNED_LEGAL_HOLDS');
    expect(detail.governance.policyVersion).toBe(detail.policyVersion);
  }),
);
it.effect(
  'relationship overlap is a typed conflict and no correction journal is written after failed replacement',
  () =>
    Effect.gen(function* correctionScenario7() {
      const original = relationshipRow();
      const h = transactionHarness(
        [[], [original], [], [{ partyId }], [], [{ partyId: organizationId }]],
        [],
        [[original]],
        {
          cause: {
            code: '23P01',
            constraint: 'party_relationships_no_overlap_excl',
          },
        },
      );
      const error = yield* Effect.flip(
        correctPartyFactRecord(h.transaction, tenantId, relationshipCommand, {
          actionInvocationId,
          principalId,
        }),
      );
      expect(Predicate.isTagged(error, 'PartyCorrectionConflict')).toBe(true);
      expect(error.reason).toMatch(/overlaps/u);
      expect(h.insertValues.length).toBe(1);
      // The failed Effect leaves the enclosing Core transaction to roll back the original transition.
      expect(h.insertValues[0]?.['supersedesRelationshipId']).toBe(assertionId);
    }),
);
it.effect('correction of a durable relationship preserves stored alias endpoints', () =>
  Effect.gen(function* correctionScenario8() {
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
    yield* correctPartyFactRecord(h.transaction, tenantId, relationshipCommand, {
      actionInvocationId,
      principalId,
    });
    expect(h.insertValues[0]?.['fromPartyId']).toBe(partyId);
    expect(h.insertValues[0]?.['fromPartyId']).not.toBe(canonicalId);
  }),
);
it('correction history requires reviewer authority; ordinary identity read permission is insufficient', () => {
  const target = partyCorrectionPermissionTarget();
  expect(target).toEqual({
    kind: 'tenant',
    permission: 'review_party_identity',
  });
  expect(target).not.toEqual({
    kind: 'tenant',
    permission: 'read_party_identity',
  });
});
for (const scenario of [
  {
    name: 'UNRESOLVED Party Type enrichment is rejected before mutation by correction',
    original: 'UNRESOLVED',
    replacement: 'PERSON',
    claimReads: [],
    reason: /enrichment/u,
  },
  {
    name: 'Party Type correction reconciles newly eligible claims before superseding the original fact',
    original: 'PERSON',
    replacement: 'ORGANIZATION',
    claimReads: [
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
    ],
    reason: /exclusive identifier claims/u,
  },
]) {
  it.effect(scenario.name, () =>
    Effect.gen(function* rejectCorrectionScenario() {
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
            normalizedValue: scenario.original,
            partyId,
            state: 'ACTIVE',
          },
        ],
        ...scenario.claimReads,
      ]);
      const command = yield* Schema.decodeUnknownEffect(PartyCorrectionCommandSchema)({
        ...evidence,
        factKind: 'PARTY_TYPE',
        partyId,
        replacementValue: scenario.replacement,
        subjectEvidence: [
          {
            basis: 'REVIEWED_DOCUMENT',
            evidenceRef: 'record/42',
            kind: 'ACTOR_ATTESTATION',
            observedSubject: scenario.replacement,
            statement: 'Reviewed this external organization',
            subjectKey: 'one-subject',
          },
        ],
        targetAssertionId: assertionId,
      });
      const error = yield* Effect.flip(
        correctPartyFactRecord(h.transaction, tenantId, command, {
          actionInvocationId,
          principalId,
        }),
      );
      expect(Predicate.isTagged(error, 'PartyCorrectionConflict')).toBe(true);
      expect(error.reason).toMatch(scenario.reason);
      expect(h.updateSets.length).toBe(0);
      expect(h.insertValues.length).toBe(0);
    }),
  );
}

it.effect('type Correction cannot treat a reviewer decision or source label as subject evidence', () =>
  Effect.gen(function* correctionScenario10() {
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
    const command = yield* Schema.decodeEffect(PartyCorrectionCommandSchema)({
      ...evidence,
      factKind: 'PARTY_TYPE',
      partyId,
      replacementValue: 'ORGANIZATION',
      targetAssertionId: assertionId,
    });
    const error = yield* Effect.flip(
      correctPartyFactRecord(h.transaction, tenantId, command, {
        actionInvocationId,
        principalId,
      }),
    );
    expect(Predicate.isTagged(error, 'PartyCorrectionConflict')).toBe(true);
    expect(error.reason).toBe('subject_evidence_required');
    expect(h.insertValues.length).toBe(0);
    expect(h.updateSets.length).toBe(0);
  }),
);

it.effect(
  'Party Type correction rejects active current and future CONTACT_PERSON_OF dependencies with sorted refs',
  () =>
    Effect.forEach(
      [
        {
          name: 'PERSON to ORGANIZATION current from endpoint',
          partyId,
          original: 'PERSON',
          replacement: 'ORGANIZATION',
          relationshipId: '91000000-0000-4000-8000-000000000002',
          validFrom: null,
          validTo: null,
        },
        {
          name: 'PERSON to ORGANIZATION future from endpoint',
          partyId,
          original: 'PERSON',
          replacement: 'ORGANIZATION',
          relationshipId: '91000000-0000-4000-8000-000000000001',
          validFrom: DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00.000Z')),
          validTo: DateTime.toDateUtc(DateTime.makeUnsafe('2030-02-01T00:00:00.000Z')),
        },
        {
          name: 'ORGANIZATION to PERSON current to endpoint',
          partyId: organizationId,
          original: 'ORGANIZATION',
          replacement: 'PERSON',
          relationshipId: '91000000-0000-4000-8000-000000000004',
          validFrom: null,
          validTo: null,
        },
        {
          name: 'ORGANIZATION to PERSON future to endpoint',
          partyId: organizationId,
          original: 'ORGANIZATION',
          replacement: 'PERSON',
          relationshipId: '91000000-0000-4000-8000-000000000003',
          validFrom: DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00.000Z')),
          validTo: DateTime.toDateUtc(DateTime.makeUnsafe('2030-02-01T00:00:00.000Z')),
        },
      ],
      (scenario) =>
        Effect.gen(function* typeRelationshipScenario() {
          const targetAssertion = {
            assertionId,
            factKind: 'PARTY_TYPE',
            isCurrent: true,
            normalizedValue: scenario.original,
            partyId: scenario.partyId,
            state: 'ACTIVE',
          };
          const relationship = relationshipRow({
            fromPartyId: partyId,
            relationshipId: scenario.relationshipId,
            toPartyId: organizationId,
            validFrom: scenario.validFrom,
            validTo: scenario.validTo,
          });
          const h = transactionHarness([
            [],
            [{ partyId: scenario.partyId }],
            [],
            [{ partyId: scenario.partyId }],
            [targetAssertion],
            [],
            [],
            [],
            [relationship],
          ]);
          const command = yield* Schema.decodeUnknownEffect(PartyCorrectionCommandSchema)({
            ...evidence,
            factKind: 'PARTY_TYPE',
            partyId: scenario.partyId,
            replacementValue: scenario.replacement,
            subjectEvidence: [
              {
                basis: 'REVIEWED_DOCUMENT',
                evidenceRef: 'record/type-correction',
                kind: 'ACTOR_ATTESTATION',
                observedSubject: scenario.replacement,
                statement: 'Reviewed one external subject',
                subjectKey: 'one-subject',
              },
            ],
            targetAssertionId: assertionId,
          });
          const outcome = yield* Effect.flip(
            correctPartyFactRecord(h.transaction, tenantId, command, {
              actionInvocationId,
              principalId,
            }),
          );
          expect(Predicate.isTagged(outcome, 'PartyCorrectionConflict')).toBe(true);
          if (!Schema.is(PartyCorrectionConflict)(outcome)) {
            expect.unreachable('Expected a PartyCorrectionConflict');
          }
          expect(outcome.conflictingRelationshipRefs?.map((ref) => ref.resourceId)).toEqual([scenario.relationshipId]);
          expect(outcome.reason).toBe('The corrected Party Type conflicts with active Party Relationships');
          expect(h.updateSets.length).toBe(0);
          expect(h.insertValues.length).toBe(0);
        }),
      { concurrency: 1 },
    ),
);

it.effect(
  'Party Type correction without dependent relationships preserves the existing successful correction flow',
  () =>
    Effect.gen(function* unaffectedTypeRelationshipScenario() {
      const targetAssertion = {
        assertionId,
        factKind: 'PARTY_TYPE',
        isCurrent: true,
        normalizedValue: 'PERSON',
        partyId,
        state: 'ACTIVE',
      };
      const replacement = { assertionId: replacementId };
      const h = transactionHarness(
        [[], [{ partyId }], [], [{ partyId }], [targetAssertion], [], [], [], []],
        [[replacement], [{ correctionId }]],
        [[targetAssertion], [{ partyId }]],
      );
      const command = yield* Schema.decodeEffect(PartyCorrectionCommandSchema)({
        ...evidence,
        factKind: 'PARTY_TYPE',
        partyId,
        replacementValue: 'ORGANIZATION',
        subjectEvidence: [
          {
            basis: 'REVIEWED_DOCUMENT',
            evidenceRef: 'record/type-correction-control',
            kind: 'ACTOR_ATTESTATION',
            observedSubject: 'ORGANIZATION',
            statement: 'Reviewed one external subject',
            subjectKey: 'one-subject',
          },
        ],
        targetAssertionId: assertionId,
      });
      const result = yield* correctPartyFactRecord(h.transaction, tenantId, command, {
        actionInvocationId,
        principalId,
      });
      expect(result.factKind).toBe('PARTY_TYPE');
      expect(h.updateSets.length).toBe(2);
      expect(h.insertValues.length).toBe(2);
    }),
);

it.effect('Party Type correction does not let compatible relationships hide a later conflicting dependency', () =>
  Effect.gen(function* boundedRelationshipConflictScenario() {
    const targetAssertion = {
      assertionId,
      factKind: 'PARTY_TYPE',
      isCurrent: true,
      normalizedValue: 'PERSON',
      partyId,
      state: 'ACTIVE',
    };
    const compatibleRows = Array.from({ length: 33 }, (_, index) =>
      relationshipRow({
        fromPartyId: organizationId,
        relationshipId: `92000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
        toPartyId: partyId,
      }),
    );
    const conflictingRow = relationshipRow({
      relationshipId: '93000000-0000-4000-8000-000000000001',
    });
    const h = transactionHarness([
      [],
      [{ partyId }],
      [],
      [{ partyId }],
      [targetAssertion],
      [],
      [],
      [],
      [...compatibleRows, conflictingRow],
    ]);
    const command = yield* Schema.decodeEffect(PartyCorrectionCommandSchema)({
      ...evidence,
      factKind: 'PARTY_TYPE',
      partyId,
      replacementValue: 'ORGANIZATION',
      subjectEvidence: [
        {
          basis: 'REVIEWED_DOCUMENT',
          evidenceRef: 'record/type-correction-bounded',
          kind: 'ACTOR_ATTESTATION',
          observedSubject: 'ORGANIZATION',
          statement: 'Reviewed one external subject',
          subjectKey: 'one-subject',
        },
      ],
      targetAssertionId: assertionId,
    });
    const error = yield* Effect.flip(
      correctPartyFactRecord(h.transaction, tenantId, command, {
        actionInvocationId,
        principalId,
      }),
    );
    expect(Predicate.isTagged(error, 'PartyCorrectionConflict')).toBe(true);
    if (!Schema.is(PartyCorrectionConflict)(error)) {
      expect.unreachable('Expected a PartyCorrectionConflict');
    }
    expect(error.conflictingRelationshipRefs?.map((ref) => ref.resourceId)).toEqual([conflictingRow.relationshipId]);
    expect(h.updateSets.length).toBe(0);
    expect(h.insertValues.length).toBe(0);
  }),
);
