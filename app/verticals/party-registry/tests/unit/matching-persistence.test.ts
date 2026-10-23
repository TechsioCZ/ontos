/* eslint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type -- This harness implements the narrow Drizzle Effect boundary exercised by the owner-local matching service. expires: 2026-12-31. */
import { ActionRuntime } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import type { SQL } from 'drizzle-orm';
import { DateTime, Effect, Layer, Schema, Predicate, Result } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler, getActionServiceFactory } from '../../../../packages/core-runtime/src/actions/definition.ts';
import {
  PrincipalIdSchema,
  TenantIdSchema,
} from '../../../../packages/core-runtime/src/auth/external-identity-contracts.ts';
import { RetailEnrollmentEvidenceSchema } from '../../shared/actions/accept-retail-enrollment-evidence.ts';
import type { PartyCandidate } from '../../shared/domain/identity-contracts.ts';
import { makePartyRef, partySubjectKeyFromString } from '../../shared/domain/identity-contracts.ts';
import { PartyAliasWriteRejected } from '../../shared/domain/merge-alias-resolution.ts';
import { makeDuplicateCandidateCaseRef } from '../../shared/resources/duplicate-candidate-case.ts';
import { acceptRetailEnrollmentEvidenceAction } from '../../src/actions/accept-retail-enrollment-evidence.action.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { matchPartyAction } from '../../src/actions/match-party.action.ts';
import { resolveDuplicateCandidateMatchAction } from '../../src/actions/resolve-duplicate-candidate-match.action.ts';
import { partyMatchRead } from '../../src/api/party-match.read.ts';
import {
  duplicateCandidateCaseParties,
  duplicateCandidateCases,
  parties,
  partyAliases,
  partyIdentifierClaims,
  partyMatchDecisions,
  partyOfficialIdentifiers,
} from '../../src/db/schema.ts';
import {
  caseEvaluationFingerprint,
  candidateFingerprint,
  createOrMatchParty,
  acceptRetailEnrollmentEvidence,
  findPartyCreateContinuation,
  matchParty,
  resolveDuplicateCandidateCreate,
  resolveDuplicateCandidateMatch,
} from '../../src/services/party-matching-persistence.service.ts';

const tenantId = Schema.decodeSync(TenantIdSchema)('10000000-0000-4000-8000-000000000001');
const partyA = '20000000-0000-4000-8000-000000000001';
const partyB = '20000000-0000-4000-8000-000000000002';
const partyC = '20000000-0000-4000-8000-000000000003';
const candidateCaseId = '30000000-0000-4000-8000-000000000001';
const decisionId = '40000000-0000-4000-8000-000000000001';
const actionInvocationId = '50000000-0000-4000-8000-000000000001';
const principalId = Schema.decodeSync(PrincipalIdSchema)('60000000-0000-4000-8000-000000000001');
const officialIdentifierId = '70000000-0000-4000-8000-000000000001';
const instant = '2020-01-01T00:00:00.000Z';
const candidate = (overrides: Partial<PartyCandidate> = {}): PartyCandidate => ({
  evidenceRefs: ['registry:verified:entry-42'],
  officialIdentifiers: [
    { identifierType: 'ICO', value: '27074358', verification: 'VERIFIED' },
    { identifierType: 'CZ_DIC', value: 'CZ27074358', verification: 'VERIFIED' },
  ],
  partyType: 'ORGANIZATION',
  provenance: { method: 'OFFICIAL_RECORD', source: 'verified-register' },
  subjectEvidence: [
    {
      basis: 'REVIEWED_DOCUMENT',
      evidenceRef: 'record/42',
      kind: 'ACTOR_ATTESTATION',
      observedSubject: 'ORGANIZATION',
      statement: 'Reviewed evidence for this external organization',
      subjectKey: partySubjectKeyFromString('one-subject'),
    },
  ],
  validFrom: DateTime.makeUnsafe(instant),
  ...overrides,
});
const caseRow = () => ({
  candidateCaseId,
  candidateFingerprint: 'a'.repeat(64),
  candidateSnapshot: {
    evidenceArtifactRefs: candidate().evidenceRefs,
    names: [],
    officialIdentifiers: [
      {
        identifierTypeKey: 'ICO',
        namespace: 'CZ:ICO',
        normalizedValue: '27074358',
        verificationState: 'VERIFIED',
      },
    ],
    partyType: 'ORGANIZATION',
    provenance: candidate().provenance,
    subjectEvidence: candidate().subjectEvidence,
    validFrom: instant,
  },
  lifecycleState: 'OPEN',
  revision: 1,
  tenantId,
});

type Row = Readonly<Record<string, unknown>>;
type Rows = readonly Row[];
type HarnessTable =
  | SQL
  | typeof duplicateCandidateCaseParties
  | typeof duplicateCandidateCases
  | typeof parties
  | typeof partyAliases
  | typeof partyIdentifierClaims
  | typeof partyMatchDecisions
  | typeof partyOfficialIdentifiers;
type RecordedValues = Row | readonly Row[] | undefined;
const recordedRow = (values: RecordedValues): Row => {
  expect(values !== undefined && !Array.isArray(values)).toBe(true);
  // SAFETY: the recorded insert was checked to be a present single row rather than a batch.
  return values as Row;
};
const recordedRows = (values: RecordedValues): readonly Row[] => {
  expect(Array.isArray(values)).toBe(true);
  // SAFETY: the recorded insert was checked to be the batch of rows used by this harness.
  return values as readonly Row[];
};
const harness = (queues: ReadonlyMap<unknown, readonly Rows[]> = new Map()) => {
  const results = new Map([...queues].map(([table, rows]) => [table, [...rows]]));
  const reads: { table: unknown; locked: boolean }[] = [];
  const inserts: { table: unknown; values: Row | readonly Row[] }[] = [];
  const updates: { table: unknown; values: Row }[] = [];
  const select = () => {
    let selected: unknown;
    let rows: Rows | undefined;
    const read = { locked: false, table: selected };
    const resolve = () => (rows ??= results.get(selected)?.shift() ?? []);
    const chain = Object.assign(
      Effect.sync(() => resolve()),
      {
        for: () => {
          read.locked = true;
          return chain;
        },
        from: (table: HarnessTable) => {
          selected = table;
          read.table = table;
          reads.push(read);
          return chain;
        },
        limit: () => chain,
        orderBy: () => chain,
        where: () => chain,
      },
    );
    return chain;
  };
  const insert = (table: HarnessTable) => {
    let values: Row | readonly Row[] = {};
    const returned = () => {
      if (table === duplicateCandidateCases) {
        return [{ ...caseRow(), ...values }];
      }
      if (table === partyMatchDecisions) {
        return [{ matchDecisionId: decisionId, ...values }];
      }
      if (table === partyOfficialIdentifiers) {
        return [{ officialIdentifierId, ...values }];
      }
      if (table === parties) {
        return [
          {
            partyId: partyA,
            archivedAt: null,
            createdAt: DateTime.toDateUtc(DateTime.makeUnsafe(instant)),
            updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe(instant)),
            revision: 1,
            ...values,
          },
        ];
      }
      return [];
    };
    const chain = Object.assign(
      Effect.sync(() => returned()),
      {
        returning: () => Effect.succeed(returned()),
        values: (input: Row | readonly Row[]) => {
          values = input;
          inserts.push({ table, values });
          return chain;
        },
      },
    );
    return chain;
  };
  const update = (table: HarnessTable) => {
    let values: Row = {};
    const chain = Object.assign(
      Effect.sync(() => []),
      {
        returning: () =>
          Effect.succeed([
            {
              officialIdentifierId,
              partyId: partyA,
              state: 'ACTIVE',
              isCurrent: true,
              validTo: null,
              verificationState: 'VERIFIED',
              verifiedAt: DateTime.toDateUtc(DateTime.makeUnsafe(instant)),
              verifiedByPrincipalId: principalId,
              ...values,
            },
          ]),
        set: (next: Row) => {
          values = next;
          updates.push({ table, values });
          return chain;
        },
        where: () => chain,
      },
    );
    return chain;
  };
  // SAFETY: this test double implements exactly the fluent methods called by the persistence seam.
  const transaction = { insert, select, update } as unknown as Parameters<typeof resolveDuplicateCandidateMatch>[0];
  return { inserts, reads, transaction, updates };
};

const ambiguousHarness = (existingCase: boolean) =>
  harness(
    new Map<unknown, readonly Rows[]>([
      [partyIdentifierClaims, [[{ partyId: partyA }], [{ partyId: partyB }]]],
      [partyAliases, [[], []]],
      [parties, [[{ partyId: partyA }], [{ partyId: partyB }]]],
      [duplicateCandidateCases, [existingCase ? [caseRow()] : []]],
      [duplicateCandidateCaseParties, [existingCase ? [{ partyId: partyA }] : []]],
    ]),
  );

it.layer(
  Layer.effectDiscard(TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-01T00:00:00.000Z')))),
)('matching-persistence', (testIt) => {
  testIt.effect(
    'durable Party Match commits an ambiguity decision, complete case references, and original evidence without mutating a Party',
    () =>
      Effect.gen(function* durablePartyMatchCommitsAnAmbiguityDecision() {
        const subject = ambiguousHarness(false);
        const result = yield* matchParty(subject.transaction, {
          actionInvocationId,
          candidate: candidate(),
          tenantId,
        });
        expect(result.outcome).toBe('AMBIGUOUS');
        expect(result.candidateParties.map((ref) => ref.resourceId)).toEqual([partyA, partyB]);
        expect(result.decisionRef.resourceId).toBe(decisionId);
        expect(subject.inserts.map(({ table }) => table)).toEqual([
          duplicateCandidateCases,
          duplicateCandidateCaseParties,
          partyMatchDecisions,
        ]);
        const caseValues = recordedRow(subject.inserts[0]?.values);
        // SAFETY: this fixture records the concrete candidateSnapshot inserted by the matching service.
        const snapshot = caseValues['candidateSnapshot'] as Row;
        expect(snapshot['names']).toEqual([]);
        expect(snapshot['provenance']).toEqual(candidate().provenance);
        expect(snapshot['validFrom']).toBe(instant);
        const linked = recordedRows(subject.inserts[1]?.values);
        expect(linked.map((row) => [row['partyId'], row['rank']])).toEqual([
          [partyA, 1],
          [partyB, 2],
        ]);
        expect(recordedRow(subject.inserts[2]?.values)['candidateCaseId']).toBe(candidateCaseId);
        expect(subject.updates.length).toBe(0);
        expect(subject.reads[0]?.table, 'tenant serialization lock precedes row/claim reads').not.toBe(
          partyIdentifierClaims,
        );
      }),
  );

  testIt.effect(
    'an unchanged open ambiguity reuses its immutable evaluated case without rewriting candidate links',
    () =>
      Effect.gen(function* anUnchangedOpenAmbiguityReusesItsImmutable() {
        const subject = ambiguousHarness(true);
        yield* matchParty(subject.transaction, {
          actionInvocationId,
          candidate: candidate(),
          tenantId,
        });
        expect(subject.inserts.map(({ table }) => table)).toEqual([partyMatchDecisions]);
        expect(subject.updates.length, 'the original case snapshot is never overwritten').toBe(0);
      }),
  );

  testIt.effect(
    'PERSON IČO cannot acquire organization auto-match authority and NO_MATCH still records a decision',
    () =>
      Effect.gen(function* personIOCannotAcquireOrganizationAuto() {
        const subject = harness();
        const result = yield* matchParty(subject.transaction, {
          actionInvocationId,
          candidate: candidate({
            officialIdentifiers: [
              {
                identifierType: 'ICO',
                value: '27074358',
                verification: 'VERIFIED',
              },
            ],
            partyType: 'PERSON',
            subjectEvidence: [
              {
                basis: 'DIRECT_INTERACTION',
                evidenceRef: 'meeting/42',
                kind: 'ACTOR_ATTESTATION',
                observedSubject: 'PERSON',
                statement: 'Met this human',
                subjectKey: partySubjectKeyFromString('one-subject'),
              },
            ],
          }),
          tenantId,
        });
        expect(result.outcome).toBe('NO_MATCH');
        const durable = recordedRow(subject.inserts.find(({ table }) => table === partyMatchDecisions)?.values);
        expect(durable['operation']).toBe('MATCH');
        expect(durable['committedCreateOutcome']).toBe(null);
        expect(result.candidateParties).toEqual([]);
        expect(subject.inserts.map(({ table }) => table)).toEqual([partyMatchDecisions]);
        expect(subject.reads.some(({ table }) => table === partyIdentifierClaims)).toBe(false);
      }),
  );

  const resolutionInput = {
    actionInvocationId,
    candidateCaseId,
    expectedRevision: 1,
    principalId,
    reason: 'Reviewed authoritative evidence',
    selectedPartyId: partyC,
    selectedPartyTenantId: tenantId,
    tenantId,
  };

  testIt.effect(
    'an unarchive review cannot create a replacement Party or attach its facts through Candidate matching',
    () =>
      Effect.gen(function* unarchiveIntentBoundary() {
        for (const resolution of ['CREATE', 'MATCH']) {
          const original = caseRow();
          const subject = harness(
            new Map<unknown, readonly Rows[]>([
              [
                duplicateCandidateCases,
                [
                  [
                    {
                      ...original,
                      candidateSnapshot: {
                        ...original.candidateSnapshot,
                        intent: 'UNARCHIVE',
                      },
                    },
                  ],
                ],
              ],
            ]),
          );
          const error =
            resolution === 'CREATE'
              ? yield* Effect.flip(resolveDuplicateCandidateCreate(subject.transaction, resolutionInput))
              : yield* Effect.flip(resolveDuplicateCandidateMatch(subject.transaction, resolutionInput));
          expect(Predicate.isTagged(error, 'DuplicateCandidateConflict')).toBe(true);
          expect(error.reason).toMatch(/unarchive/iu);
          expect(subject.inserts).toEqual([]);
          expect(subject.updates).toEqual([]);
        }
      }),
  );

  const activePartyRow = (partyId: string) => ({
    archivedAt: null,
    createdAt: DateTime.toDateUtc(DateTime.makeUnsafe(instant)),
    currentDisplayName: null,
    currentType: 'ORGANIZATION',
    partyId,
    revision: 1,
    tenantId,
    updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe(instant)),
  });
  const actionScope = {
    authMethod: 'system' as const,
    correlationId: 'matching-events',
    principalId,
    tenantId,
  };

  testIt.effect(
    'Create Party matching an existing subject publishes each newly accepted identifier without fabricating Party Created',
    () =>
      Effect.gen(function* createPartyMatchingAnExistingSubjectPublishes() {
        const subject = harness(
          new Map<unknown, readonly Rows[]>([
            [partyIdentifierClaims, [[{ partyId: partyA }], []]],
            [parties, [[activePartyRow(partyA)]]],
            [partyOfficialIdentifiers, [[]]],
          ]),
        );
        const collector = createActionCollector(
          createPartyAction.descriptor.domainEvents,
          'party.registry',
          createPartyAction.descriptor.accessEvidencePolicy,
        );
        const result = yield* getActionHandler(createPartyAction)(
          { candidate: candidate() },
          {
            ...collector,
            actionInvocationId,
            compositionRevision: 'a'.repeat(64),
            scope: actionScope,
            services: {
              createOrMatch: (value, invocationId) =>
                createOrMatchParty(subject.transaction, {
                  actionInvocationId: invocationId,
                  candidate: value,
                  principalId,
                  tenantId,
                }),
            },
          },
        );
        if (!('outcome' in result)) {
          throw new Error('create-party matching did not return its committed result');
        }
        expect(result.outcome).toBe('MATCHED_EXISTING');
        const durable = recordedRow(subject.inserts.find(({ table }) => table === partyMatchDecisions)?.values);
        expect(durable['operation']).toBe('CREATE');
        expect(durable['committedCreateOutcome']).toBe('MATCHED_EXISTING');
        expect('addedOfficialIdentifierRefs' in result, 'mutation metadata stays private to the Action').toBe(false);
        const evidence = collector.snapshot();
        expect(evidence.domainEvents.map((event) => event.eventType)).toEqual([
          'party.registry.official-identifier-added.v1',
        ]);
        expect(evidence.outboxMessages.length).toBe(1);
        expect(evidence.outboxMessages[0]?.domainEventIndex).toBe(0);
        expect(evidence.outboxMessages[0]?.message.payloadJson).toEqual({
          officialIdentifierRef: {
            moduleId: 'party.registry',
            resourceId: officialIdentifierId,
            resourceType: 'party.registry.party-official-identifier',
            tenantId,
          },
          partyRef: makePartyRef(tenantId, partyA),
        });
      }),
  );

  testIt.effect('Create upgrades a same-Party UNVERIFIED identifier and publishes one update event', () =>
    Effect.gen(function* createUpgradesUnverifiedIdentifier() {
      const subject = harness(
        new Map<unknown, readonly Rows[]>([
          [partyIdentifierClaims, [[{ partyId: partyA }], []]],
          [parties, [[activePartyRow(partyA)], [activePartyRow(partyA)], [activePartyRow(partyA)]]],
          [
            partyOfficialIdentifiers,
            [
              [
                {
                  acceptedByActionInvocationId: 'prior-acceptance',
                  officialIdentifierId,
                  partyId: partyA,
                  state: 'ACTIVE',
                  isCurrent: true,
                  validTo: null,
                  verificationState: 'UNVERIFIED',
                  verifiedAt: null,
                  verifiedByPrincipalId: null,
                },
              ],
            ],
          ],
        ]),
      );
      const collector = createActionCollector(
        createPartyAction.descriptor.domainEvents,
        'party.registry',
        createPartyAction.descriptor.accessEvidencePolicy,
      );
      const result = yield* getActionHandler(createPartyAction)(
        {
          candidate: candidate({
            officialIdentifiers: [
              { identifierType: 'ICO', value: '27074358', verification: 'VERIFIED' },
              { identifierType: 'CZ_DIC', value: 'CZ27074358', verification: 'VERIFIED' },
            ],
          }),
        },
        {
          ...collector,
          actionInvocationId,
          compositionRevision: 'a'.repeat(64),
          scope: actionScope,
          services: {
            createOrMatch: (value, invocationId) =>
              createOrMatchParty(subject.transaction, {
                actionInvocationId: invocationId,
                candidate: value,
                principalId,
                tenantId,
              }),
          },
        },
      );
      if (!('outcome' in result)) {
        throw new Error('create matching did not return its committed result');
      }
      expect(result.outcome).toBe('MATCHED_EXISTING');
      expect(subject.updates.some(({ values }) => values['verificationState'] === 'VERIFIED')).toBe(true);
      expect(collector.snapshot().domainEvents.map((event) => event.eventType)).toEqual([
        'party.registry.official-identifier-updated.v1',
      ]);
      expect(collector.snapshot().domainEvents[0]?.subjectResourceType).toBe(
        'party.registry.party-official-identifier',
      );
      expect(collector.snapshot().outboxMessages).toHaveLength(1);
    }),
  );

  testIt.effect('Create replays an unchanged resolved MATCH_EXISTING case without opening another case', () =>
    Effect.gen(function* createReplaysResolvedMatch() {
      const weakCandidate = candidate({
        officialIdentifiers: [{ identifierType: 'ICO', value: '27074358', verification: 'UNVERIFIED' }],
      });
      const evidenceExplanation = [
        {
          evidenceRefs: [...weakCandidate.evidenceRefs].toSorted(),
          outcome: 'AMBIGUOUS' as const,
          reason:
            'No qualifying exclusive identifier establishes one existing Party; bounded subject evidence requires the declared rule outcome',
          ruleKey: 'party-exact-claims.v1',
        },
      ];
      const resolvedCase = {
        ...caseRow(),
        candidateFingerprint: candidateFingerprint(weakCandidate),
        evaluationFingerprint: caseEvaluationFingerprint(weakCandidate, [partyA], evidenceExplanation),
        lifecycleState: 'RESOLVED',
        resolutionOutcome: 'MATCH_EXISTING',
        selectedPartyId: partyA,
      };
      const subject = harness(
        new Map<unknown, readonly Rows[]>([
          [partyOfficialIdentifiers, [[{ partyId: partyA }]]],
          [duplicateCandidateCases, [[], [resolvedCase]]],
          [partyAliases, [[]]],
          [parties, [[activePartyRow(partyA)], [activePartyRow(partyA)], [activePartyRow(partyA)]]],
        ]),
      );
      const result = yield* createOrMatchParty(subject.transaction, {
        actionInvocationId: 'replay-create-invocation',
        candidate: weakCandidate,
        principalId,
        tenantId,
      });
      expect(result.outcome).toBe('MATCHED_EXISTING');
      if (!('partyRef' in result)) {
        throw new Error('resolved replay did not return a Party');
      }
      expect(result.partyRef.resourceId).toBe(partyA);
      expect(subject.inserts.filter(({ table }) => table === duplicateCandidateCases)).toEqual([]);
      expect(subject.inserts.filter(({ table }) => table === partyMatchDecisions)).toHaveLength(1);
    }),
  );

  testIt.effect('material Candidate evidence creates a linked OPEN successor after resolved matching', () =>
    Effect.gen(function* materialCandidateCreatesSuccessor() {
      const priorId = '30000000-0000-4000-8000-000000000099';
      const subject = harness(
        new Map<unknown, readonly Rows[]>([
          [partyIdentifierClaims, [[{ partyId: partyA }], [{ partyId: partyB }]]],
          [partyAliases, [[], []]],
          [parties, [[{ partyId: partyA }], [{ partyId: partyB }]]],
          [
            duplicateCandidateCases,
            [
              [
                {
                  ...caseRow(),
                  candidateCaseId: priorId,
                  lifecycleState: 'RESOLVED',
                  resolutionOutcome: 'MATCH_EXISTING',
                  selectedPartyId: partyA,
                },
              ],
              [],
              [],
              [{ ...caseRow(), candidateCaseId: priorId }],
            ],
          ],
        ]),
      );
      const result = yield* matchParty(subject.transaction, {
        actionInvocationId: 'material-evaluation-invocation',
        candidate: candidate({ evidenceRefs: ['registry:verified:entry-43'] }),
        priorCandidateCaseId: priorId,
        priorCaseTenantId: tenantId,
        tenantId,
      });
      expect(result.outcome).toBe('AMBIGUOUS');
      const inserted = subject.inserts.find(({ table }) => table === duplicateCandidateCases)?.values;
      if (inserted === undefined || Array.isArray(inserted)) {
        throw new Error('successor case was not inserted');
      }
      // SAFETY: the preceding guard excludes the batch-array insert representation.
      const insertedValues = inserted as Readonly<Record<string, unknown>>;
      expect(insertedValues['priorCandidateCaseId']).toBe(priorId);
      expect(insertedValues['lifecycleState']).toBeUndefined();
    }),
  );

  const invokeReviewedMatch = (subject: ReturnType<typeof harness>) =>
    Effect.gen(function* invokeReviewedMatchEffect() {
      const collector = createActionCollector(
        resolveDuplicateCandidateMatchAction.descriptor.domainEvents,
        'party.registry',
        resolveDuplicateCandidateMatchAction.descriptor.accessEvidencePolicy,
      );
      const result = yield* getActionHandler(resolveDuplicateCandidateMatchAction)(
        {
          caseRef: makeDuplicateCandidateCaseRef(tenantId, candidateCaseId),
          expectedRevision: 1,
          reason: resolutionInput.reason,
          selectedPartyRef: makePartyRef(tenantId, partyC),
        },
        {
          ...collector,
          actionInvocationId,
          compositionRevision: 'a'.repeat(64),
          scope: actionScope,
          services: {
            resolve: () => resolveDuplicateCandidateMatch(subject.transaction, resolutionInput),
          },
        },
      );
      return { collector, result };
    });

  testIt.effect(
    'reviewed matching publishes the accepted identifier through its declared Action event and linked outbox',
    () =>
      Effect.gen(function* reviewedMatchingPublishesTheAcceptedIdentifierThrough() {
        const subject = harness(
          new Map<unknown, readonly Rows[]>([
            [duplicateCandidateCases, [[caseRow()]]],
            [partyAliases, [[]]],
            [parties, [[activePartyRow(partyC)], [activePartyRow(partyC)]]],
            [partyIdentifierClaims, [[]]],
            [partyOfficialIdentifiers, [[]]],
          ]),
        );
        const { collector, result } = yield* invokeReviewedMatch(subject);
        if (!('outcome' in result)) {
          throw new Error('duplicate-candidate resolution did not return its committed result');
        }
        expect(result.outcome).toBe('MATCH_EXISTING');
        expect('addedOfficialIdentifierRefs' in result).toBe(false);
        const evidence = collector.snapshot();
        expect(evidence.domainEvents.map((event) => event.eventType)).toEqual([
          'party.registry.official-identifier-added.v1',
        ]);
        expect(evidence.outboxMessages.length).toBe(1);
        expect(evidence.outboxMessages[0]?.domainEventIndex).toBe(0);
        expect(evidence.outboxMessages[0]?.message.topic).toBe('party.registry.official-identifier-added.v1');
        expect(evidence.outboxMessages[0]?.message.payloadJson).toEqual(evidence.domainEvents[0]?.payloadJson);
      }),
  );

  testIt.effect('reviewed MATCH_EXISTING upgrades a same-Party UNVERIFIED identifier', () =>
    Effect.gen(function* reviewedMatchingUpgradesUnverifiedIdentifier() {
      const subject = harness(
        new Map<unknown, readonly Rows[]>([
          [duplicateCandidateCases, [[caseRow()]]],
          [partyAliases, [[]]],
          [parties, [[activePartyRow(partyC)], [activePartyRow(partyC)]]],
          [partyIdentifierClaims, [[]]],
          [
            partyOfficialIdentifiers,
            [
              [
                {
                  acceptedByActionInvocationId: 'prior-acceptance',
                  officialIdentifierId,
                  partyId: partyC,
                  state: 'ACTIVE',
                  isCurrent: true,
                  validTo: null,
                  verificationState: 'UNVERIFIED',
                  verifiedAt: null,
                  verifiedByPrincipalId: null,
                },
              ],
            ],
          ],
        ]),
      );
      const { collector, result } = yield* invokeReviewedMatch(subject);
      if (!('outcome' in result)) {
        throw new Error('reviewed matching did not return its committed result');
      }
      const snapshot = collector.snapshot();
      expect({
        eventTypes: snapshot.domainEvents.map((event) => event.eventType),
        identifierUpgraded: subject.updates.some(({ values }) => values['verificationState'] === 'VERIFIED'),
        outboxCount: snapshot.outboxMessages.length,
        outcome: result.outcome,
      }).toEqual({
        eventTypes: ['party.registry.official-identifier-updated.v1'],
        identifierUpgraded: true,
        outboxCount: 1,
        outcome: 'MATCH_EXISTING',
      });
    }),
  );

  testIt.effect('matched Create reusing an existing identifier does not republish an acceptance event', () =>
    Effect.gen(function* matchedCreateReusingAnExistingIdentifierDoes() {
      const subject = harness(
        new Map<unknown, readonly Rows[]>([
          [partyIdentifierClaims, [[{ partyId: partyA }]]],
          [parties, [[activePartyRow(partyA)]]],
          [
            partyOfficialIdentifiers,
            [
              [
                {
                  acceptedByActionInvocationId: 'prior-acceptance',
                  officialIdentifierId,
                  partyId: partyA,
                },
              ],
            ],
          ],
        ]),
      );
      const collector = createActionCollector(
        createPartyAction.descriptor.domainEvents,
        'party.registry',
        createPartyAction.descriptor.accessEvidencePolicy,
      );
      const result = yield* getActionHandler(createPartyAction)(
        {
          candidate: candidate({
            officialIdentifiers: [
              {
                identifierType: 'ICO',
                value: '27074358',
                verification: 'VERIFIED',
              },
              {
                identifierType: 'CZ_DIC',
                value: 'CZ27074358',
                verification: 'UNVERIFIED',
              },
            ],
          }),
        },
        {
          ...collector,
          actionInvocationId,
          compositionRevision: 'a'.repeat(64),
          scope: actionScope,
          services: {
            createOrMatch: (value, invocationId) =>
              createOrMatchParty(subject.transaction, {
                actionInvocationId: invocationId,
                candidate: value,
                principalId,
                tenantId,
              }),
          },
        },
      );
      if (!('outcome' in result)) {
        throw new Error('create-party matching did not return its committed result');
      }
      expect(result.outcome).toBe('MATCHED_EXISTING');
      expect(collector.snapshot().domainEvents).toEqual([]);
      expect(collector.snapshot().outboxMessages).toEqual([]);
      expect(subject.inserts.some(({ table }) => table === partyOfficialIdentifiers)).toBe(false);
    }),
  );

  testIt.effect('repeated Candidate facts accepted in one matching transaction publish one identifier event', () =>
    Effect.gen(function* repeatedCandidateFactsAcceptedInOneMatching() {
      const subject = harness(
        new Map<unknown, readonly Rows[]>([
          [partyIdentifierClaims, [[{ partyId: partyA }]]],
          [parties, [[activePartyRow(partyA)]]],
          [
            partyOfficialIdentifiers,
            [
              [],
              [
                {
                  acceptedByActionInvocationId: actionInvocationId,
                  officialIdentifierId,
                  partyId: partyA,
                },
              ],
            ],
          ],
        ]),
      );
      const identifier = {
        identifierType: 'CZ_DIC' as const,
        value: 'CZ27074358',
        verification: 'UNVERIFIED' as const,
      };
      const collector = createActionCollector(
        createPartyAction.descriptor.domainEvents,
        'party.registry',
        createPartyAction.descriptor.accessEvidencePolicy,
      );
      yield* getActionHandler(createPartyAction)(
        {
          candidate: candidate({
            officialIdentifiers: [
              {
                identifierType: 'ICO',
                value: '27074358',
                verification: 'VERIFIED',
              },
              identifier,
              identifier,
            ],
          }),
        },
        {
          ...collector,
          actionInvocationId,
          compositionRevision: 'a'.repeat(64),
          scope: actionScope,
          services: {
            createOrMatch: (value, invocationId) =>
              createOrMatchParty(subject.transaction, {
                actionInvocationId: invocationId,
                candidate: value,
                principalId,
                tenantId,
              }),
          },
        },
      );
      expect(subject.inserts.filter(({ table }) => table === partyOfficialIdentifiers).length).toBe(1);
      expect(collector.snapshot().domainEvents.length).toBe(1);
      expect(collector.snapshot().outboxMessages.length).toBe(1);
    }),
  );

  testIt.effect('reviewed matching with already-owned claims creates no duplicate identifier notifications', () =>
    Effect.gen(function* reviewedMatchingWithAlreadyOwnedClaimsCreates() {
      const subject = harness(
        new Map<unknown, readonly Rows[]>([
          [duplicateCandidateCases, [[caseRow()]]],
          [partyAliases, [[], []]],
          [parties, [[activePartyRow(partyC)], [activePartyRow(partyC)], [activePartyRow(partyC)]]],
          [partyIdentifierClaims, [[{ officialIdentifierId, partyId: partyC }]]],
        ]),
      );
      const { collector, result } = yield* invokeReviewedMatch(subject);
      if (!('outcome' in result)) {
        throw new Error('duplicate-candidate resolution did not return its committed result');
      }
      expect(result.outcome).toBe('MATCH_EXISTING');
      expect(collector.snapshot().domainEvents).toEqual([]);
      expect(collector.snapshot().outboxMessages).toEqual([]);
    }),
  );

  testIt.effect(
    'reviewed matching locks and rejects an archived canonical target before any attachment or resolution',
    () =>
      Effect.gen(function* reviewedMatchingLocksAndRejectsAnArchived() {
        const subject = harness(
          new Map<unknown, readonly Rows[]>([
            [duplicateCandidateCases, [[caseRow()]]],
            [partyAliases, [[]]],
            [
              parties,
              [
                [{ partyId: partyC }],
                [
                  {
                    archivedAt: DateTime.toDateUtc(DateTime.makeUnsafe(instant)),
                    currentType: 'ORGANIZATION',
                    partyId: partyC,
                  },
                ],
              ],
            ],
          ]),
        );
        const failure = yield* Effect.flip(resolveDuplicateCandidateMatch(subject.transaction, resolutionInput));
        expect(Predicate.isTagged(failure, 'DuplicateCandidateConflict')).toBe(true);
        expect(subject.reads.some(({ table, locked }) => table === parties && locked)).toBe(true);
        expect(subject.inserts).toEqual([]);
        expect(subject.updates).toEqual([]);
      }),
  );

  testIt.effect('reviewed matching rejects a cross-tenant selected reference without resolving its identity', () =>
    Effect.gen(function* reviewedMatchingRejectsACrossTenantSelected() {
      const subject = harness();
      const failure = yield* Effect.flip(
        resolveDuplicateCandidateMatch(subject.transaction, {
          ...resolutionInput,
          selectedPartyTenantId: '90000000-0000-4000-8000-000000000001',
        }),
      );
      expect(Predicate.isTagged(failure, 'DuplicateCandidateConflict')).toBe(true);
      expect(subject.reads.length, 'only the trusted tenant serialization lock is acquired').toBe(1);
      expect(subject.inserts).toEqual([]);
    }),
  );

  testIt.effect('reviewed matching rejects an absorbed target with the full-chain canonical survivor reference', () =>
    Effect.gen(function* reviewedMatchingRejectsAnAbsorbedTargetWith() {
      const subject = harness(
        new Map<unknown, readonly Rows[]>([
          [duplicateCandidateCases, [[caseRow()]]],
          [
            partyAliases,
            [
              [{ aliasPartyId: partyB, canonicalPartyId: partyA, tenantId }],
              [{ aliasPartyId: partyA, canonicalPartyId: partyC, tenantId }],
              [],
            ],
          ],
          [parties, [[{ partyId: partyC }]]],
        ]),
      );
      const failure = yield* Effect.flip(
        resolveDuplicateCandidateMatch(subject.transaction, {
          ...resolutionInput,
          selectedPartyId: partyB,
        }),
      );
      expect(Schema.is(PartyAliasWriteRejected)(failure)).toBe(true);
      const rejection = yield* Schema.decodeUnknownEffect(PartyAliasWriteRejected)(failure);
      expect(rejection.canonicalPartyRef.resourceId).toBe(partyC);
      expect(subject.inserts).toEqual([]);
      expect(subject.updates).toEqual([]);
    }),
  );

  testIt.effect('future-effective evidence is rejected before a current decision or Party can be persisted', () =>
    Effect.gen(function* futureEffectiveEvidenceIsRejectedBeforeA() {
      const subject = harness();
      const failure = yield* Effect.flip(
        matchParty(subject.transaction, {
          actionInvocationId,
          candidate: candidate({
            validFrom: DateTime.makeUnsafe('2099-01-01T00:00:00.000Z'),
          }),
          tenantId,
        }),
      );
      expect(Predicate.isTagged(failure, 'PartyEvidenceInsufficient')).toBe(true);
      expect(subject.inserts).toEqual([]);
    }),
  );

  it('durable matching is an idempotent identity Action and the separate UX preview remains a governed read', () => {
    expect(matchPartyAction.descriptor.idempotency).toBe('required');
    expect(matchPartyAction.descriptor.tenantPermission?.({ candidate: candidate() })).toBe('manage_party_identity');
    expect(matchPartyAction.descriptor.legalEntityScope).toBe('optional');
    expect(partyMatchRead.descriptor.accessKind).toBe('detail');
  });

  testIt.effect('weak exact canonical evidence produces review rather than automatic identity or NO_MATCH', () =>
    Effect.gen(function* weakExactCanonicalEvidenceProducesReviewRather() {
      const subject = harness(
        new Map<unknown, readonly Rows[]>([
          [partyOfficialIdentifiers, [[{ partyId: partyA }]]],
          [partyAliases, [[]]],
          [parties, [[{ partyId: partyA }]]],
        ]),
      );
      const result = yield* matchParty(subject.transaction, {
        actionInvocationId,
        candidate: candidate({
          officialIdentifiers: [
            {
              identifierType: 'ICO',
              value: '27074358',
              verification: 'UNVERIFIED',
            },
          ],
          partyType: 'PERSON',
          subjectEvidence: [
            {
              basis: 'DIRECT_INTERACTION',
              evidenceRef: 'meeting/42',
              kind: 'ACTOR_ATTESTATION',
              observedSubject: 'PERSON',
              statement: 'Met this human',
              subjectKey: partySubjectKeyFromString('one-subject'),
            },
          ],
        }),
        tenantId,
      });
      expect(result.outcome).toBe('AMBIGUOUS');
      expect(result.caseRef?.resourceId).toBe(candidateCaseId);
      expect(result.candidateParties.map((ref) => ref.resourceId)).toEqual([partyA]);
      expect(subject.inserts.some(({ table }) => table === parties)).toBe(false);
    }),
  );

  testIt.effect(
    'initial no-strong Create review captures relevant same-name canonical Parties in its immutable snapshot',
    () =>
      Effect.gen(function* initialNoStrongCreateReviewCapturesRelevant() {
        const subject = harness(
          new Map<unknown, readonly Rows[]>([
            [parties, [[{ partyId: partyA }], [{ partyId: partyA }]]],
            [partyAliases, [[]]],
          ]),
        );
        const result = yield* createOrMatchParty(subject.transaction, {
          actionInvocationId,
          candidate: candidate({
            displayName: 'Northwind Workshop',
            evidenceRefs: ['business-record:contract:42'],
            officialIdentifiers: [],
            partyType: 'UNRESOLVED',
          }),
          principalId,
          tenantId,
        });
        expect(result.outcome).toBe('AMBIGUOUS');
        const links = recordedRows(
          subject.inserts.find(({ table }) => table === duplicateCandidateCaseParties)?.values,
        );
        expect(links.map((row) => row['partyId'])).toEqual([partyA]);
        expect(subject.inserts.some(({ table }) => table === parties)).toBe(false);
      }),
  );

  testIt.effect('a new material evaluation creates a linked successor without rewriting the prior case', () =>
    Effect.gen(function* aNewMaterialEvaluationCreatesALinked() {
      const priorId = '30000000-0000-4000-8000-000000000099';
      const subject = harness(
        new Map<unknown, readonly Rows[]>([
          [
            partyIdentifierClaims,
            [
              [
                {
                  officialIdentifierId: '70000000-0000-4000-8000-000000000001',
                  partyId: partyA,
                },
              ],
              [{ partyId: partyB }],
            ],
          ],
          [partyAliases, [[], []]],
          [parties, [[{ partyId: partyA }], [{ partyId: partyB }]]],
          [
            duplicateCandidateCases,
            [
              [],
              [
                {
                  ...caseRow(),
                  candidateCaseId: priorId,
                  lifecycleState: 'RESOLVED',
                },
              ],
              [{ ...caseRow(), candidateCaseId: priorId }],
            ],
          ],
        ]),
      );
      const result = yield* matchParty(subject.transaction, {
        actionInvocationId,
        candidate: candidate(),
        tenantId,
      });
      const insertedCase = recordedRow(subject.inserts.find(({ table }) => table === duplicateCandidateCases)?.values);
      expect(insertedCase['priorCandidateCaseId']).toBe(priorId);
      expect(String(insertedCase['evaluationFingerprint'])).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.evidenceExplanation[0]?.officialIdentifierRef?.resourceId).toBe(
        '70000000-0000-4000-8000-000000000001',
      );
      expect(result.evidenceExplanation[0]?.identifierType).toBe('ICO');
      expect(result.evidenceExplanation[0]?.normalizedValue).toBe('27074358');
      expect(subject.updates).toEqual([]);
    }),
  );

  testIt.effect('explicit prior-case continuation rejects foreign or missing review references', () =>
    Effect.forEach(
      [tenantId, '90000000-0000-4000-8000-000000000001'],
      (priorCaseTenantId) =>
        Effect.gen(function* rejectInvalidPriorCaseReference() {
          const subject = harness();
          const failure = yield* Effect.flip(
            matchParty(subject.transaction, {
              actionInvocationId,
              candidate: candidate(),
              priorCandidateCaseId: candidateCaseId,
              priorCaseTenantId,
              tenantId,
            }),
          );
          expect(Predicate.isTagged(failure, 'PartyEvidenceInsufficient')).toBe(true);
          expect(subject.inserts).toEqual([]);
        }),
      { concurrency: 'unbounded', discard: true },
    ),
  );

  it('equivalent Candidate property and evidence ordering has one deterministic fingerprint', () => {
    const original = candidate({
      displayName: 'Northwind',
      evidenceRefs: ['evidence:b', 'evidence:a'],
    });
    const reordered: PartyCandidate = {
      displayName: 'Northwind',
      evidenceRefs: original.evidenceRefs.toReversed(),
      officialIdentifiers: original.officialIdentifiers.toReversed(),
      partyType: original.partyType,
      provenance: {
        method: original.provenance.method,
        source: original.provenance.source,
      },
      subjectEvidence: original.subjectEvidence ?? [],
      validFrom: original.validFrom,
    };
    expect(candidateFingerprint(original)).toBe(candidateFingerprint(reordered));
  });

  testIt.effect('insufficient typed evidence cannot persist a case or decision even with a verified identifier', () =>
    Effect.gen(function* denyUnevidencedSubject() {
      for (const operation of ['CREATE', 'MATCH'] as const) {
        const subject = harness();
        const input = {
          actionInvocationId,
          candidate: candidate({ subjectEvidence: [] }),
          principalId,
          tenantId,
        };
        const failure = yield* operation === 'CREATE'
          ? Effect.flip(createOrMatchParty(subject.transaction, input))
          : Effect.flip(matchParty(subject.transaction, input));
        expect(Predicate.isTagged(failure, 'PartyEvidenceInsufficient')).toBe(true);
        expect(subject.inserts.length).toBe(0);
      }
    }),
  );

  testIt.effect('reviewer selection cannot waive missing subject/type evidence from a retained case', () =>
    Effect.gen(function* denyUnevidencedReview() {
      const row = caseRow();
      const subject = harness(
        new Map([
          [
            duplicateCandidateCases,
            [
              [
                {
                  ...row,
                  candidateSnapshot: {
                    ...row.candidateSnapshot,
                    subjectEvidence: [],
                  },
                },
              ],
            ],
          ],
        ]),
      );
      const failure = yield* Effect.flip(
        resolveDuplicateCandidateMatch(subject.transaction, {
          actionInvocationId,
          candidateCaseId,
          expectedRevision: 1,
          principalId,
          reason: 'reviewed',
          selectedPartyId: partyA,
          selectedPartyTenantId: tenantId,
          tenantId,
        }),
      );
      expect(Predicate.isTagged(failure, 'DuplicateCandidateConflict')).toBe(true);
      expect(subject.inserts.length).toBe(0);
      expect(subject.updates.length).toBe(0);
    }),
  );
});

const retailEvidence = Schema.decodeUnknownSync(RetailEnrollmentEvidenceSchema)({
  authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1' as const,
  candidateEvidenceRef: '80000000-0000-4000-8000-000000000001',
  emailOwnership: 'VERIFIED' as const,
  enrollmentAttemptId: '90000000-0000-4000-8000-000000000001',
  journey: 'RETAIL_SELF_ENROLLMENT' as const,
  providerOwnerInvocationId: 'a0000000-0000-4000-8000-000000000001',
  providerSubjectId: 'provider-retail',
  sellingLegalEntityId: partyB,
  tenantId,
});
const retailCandidate = candidate({
  officialIdentifiers: [],
  partyType: 'PERSON',
  evidenceRefs: [retailEvidence.candidateEvidenceRef],
  provenance: { method: 'commerce.portal-enrollment.self-enrollment', source: 'commerce.customer-context' },
  subjectEvidence: [
    {
      basis: 'DIRECT_INTERACTION',
      evidenceRef: retailEvidence.candidateEvidenceRef,
      kind: 'ACTOR_ATTESTATION',
      observedSubject: 'PERSON',
      statement: 'Exact enrolled subject',
      subjectKey: partySubjectKeyFromString(retailEvidence.providerSubjectId),
    },
  ],
});
const retailCase = {
  ...caseRow(),
  candidateFingerprint: candidateFingerprint(retailCandidate),
  candidateSnapshot: {
    evidenceArtifactRefs: retailCandidate.evidenceRefs,
    names: [],
    officialIdentifiers: [],
    partyType: 'PERSON',
    provenance: retailCandidate.provenance,
    subjectEvidence: retailCandidate.subjectEvidence,
    validFrom: instant,
  },
  resolutionActionInvocationId: null,
  selectedPartyId: null,
  resolutionOutcome: null,
};
const originalCreateDecision = {
  actionInvocationId,
  matchDecisionId: decisionId,
  tenantId,
  candidateCaseId,
  partyId: null,
  operation: 'CREATE',
  outcome: 'AMBIGUOUS',
  committedCreateOutcome: 'AMBIGUOUS',
  decidedAt: DateTime.toDateUtc(DateTime.makeUnsafe(instant)),
  matchRuleVersion: 'party-exact-claims.v1',
  evidenceEvaluation: null,
  evidenceExplanation: [],
};

it.effect(
  'retail policy accepts the original zero-candidate case under the canonical lock and records its named basis',
  () =>
    Effect.gen(function* policyAccept() {
      yield* TestClock.setTime(Date.parse('2026-10-01T00:00:00.000Z'));
      const subject = harness(
        new Map<unknown, readonly Rows[]>([
          [partyMatchDecisions, [[originalCreateDecision]]],
          [duplicateCandidateCases, [[retailCase], [retailCase]]],
          [duplicateCandidateCaseParties, [[]]],
        ]),
      );
      const result = yield* acceptRetailEnrollmentEvidence(subject.transaction, {
        actionInvocationId: principalId,
        originalInvocationId: actionInvocationId,
        evidence: retailEvidence,
        legalEntityId: partyB,
        principalId,
        tenantId,
      });
      expect(result.created).toBe(true);
      expect(result.result.outcome).toBe('CREATED');
      expect(subject.inserts.filter(({ table }) => table === parties)).toHaveLength(1);
      const decision = subject.inserts.find(({ table }) => table === partyMatchDecisions);
      expect(recordedRow(decision?.values)['evidenceExplanation']).toEqual([
        expect.objectContaining({ ruleKey: 'party.retail-verified-enrollment.v1', verification: 'VERIFIED' }),
      ]);
      expect(subject.updates.find(({ table }) => table === duplicateCandidateCases)?.values).toMatchObject({
        lifecycleState: 'RESOLVED',
        resolutionOutcome: 'CREATE_NEW',
        resolutionReason: 'party.retail-verified-enrollment.v1',
      });
    }),
);

it.effect('linked retail candidates remain in their original review case without inserting a Party', () =>
  Effect.gen(function* keepReview() {
    const subject = harness(
      new Map<unknown, readonly Rows[]>([
        [partyMatchDecisions, [[originalCreateDecision]]],
        [duplicateCandidateCases, [[retailCase], [retailCase]]],
        [duplicateCandidateCaseParties, [[{ partyId: partyA }]]],
      ]),
    );
    const accepted = yield* acceptRetailEnrollmentEvidence(subject.transaction, {
      actionInvocationId: principalId,
      originalInvocationId: actionInvocationId,
      evidence: retailEvidence,
      legalEntityId: partyB,
      principalId,
      tenantId,
    });
    expect(accepted.created).toBe(false);
    expect(accepted.result.outcome).toBe('AMBIGUOUS');
    expect(subject.inserts).toHaveLength(0);
    expect(subject.updates).toHaveLength(0);
  }),
);

for (const outcome of ['CREATE_NEW', 'MATCH_EXISTING'] as const) {
  it.effect(`owned invocation recovery follows governed ${outcome} without changing the immutable Create`, () =>
    Effect.gen(function* reviewContinuation() {
      const resolutionDecision = {
        ...originalCreateDecision,
        actionInvocationId: principalId,
        candidateCaseId: null,
        partyId: partyA,
        operation: outcome === 'CREATE_NEW' ? 'REVIEW_CREATE' : 'REVIEW_MATCH',
        outcome: outcome === 'CREATE_NEW' ? 'CREATED' : 'MATCHED',
        committedCreateOutcome: outcome === 'CREATE_NEW' ? 'CREATED' : null,
      };
      const subject = harness(
        new Map<unknown, readonly Rows[]>([
          [partyMatchDecisions, [[originalCreateDecision], [resolutionDecision]]],
          [
            duplicateCandidateCases,
            [
              [
                {
                  ...retailCase,
                  lifecycleState: 'RESOLVED',
                  resolutionOutcome: outcome,
                  resolutionActionInvocationId: principalId,
                  selectedPartyId: partyA,
                },
              ],
            ],
          ],
        ]),
      );
      const result = yield* findPartyCreateContinuation(subject.transaction, tenantId, actionInvocationId);
      expect(result?.outcome).toBe(outcome === 'CREATE_NEW' ? 'CREATED' : 'MATCHED_EXISTING');
      expect(subject.inserts).toHaveLength(0);
      expect(subject.updates).toHaveLength(0);
    }),
  );
}

it.effect(
  'a current candidate discovered after Create remains linked to the original case, never a stranded successor',
  () =>
    Effect.gen(function* currentCandidateReview() {
      const namedCase = {
        ...retailCase,
        candidateSnapshot: { ...retailCase.candidateSnapshot, names: [{ nameKind: 'DISPLAY', value: 'Same Name' }] },
      };
      const subject = harness(
        new Map<unknown, readonly Rows[]>([
          [partyMatchDecisions, [[originalCreateDecision]]],
          [duplicateCandidateCases, [[namedCase], [namedCase]]],
          [duplicateCandidateCaseParties, [[]]],
          [parties, [[{ partyId: partyA }], [{ partyId: partyA, currentType: 'PERSON' }]]],
        ]),
      );
      const accepted = yield* acceptRetailEnrollmentEvidence(subject.transaction, {
        actionInvocationId: principalId,
        originalInvocationId: actionInvocationId,
        evidence: retailEvidence,
        legalEntityId: partyB,
        principalId,
        tenantId,
      });
      expect(accepted.created).toBe(false);
      expect(accepted.result).toMatchObject({ outcome: 'AMBIGUOUS', caseRef: { resourceId: candidateCaseId } });
      expect(subject.inserts.map(({ table }) => table)).toEqual([duplicateCandidateCaseParties]);
      expect(recordedRows(subject.inserts[0]?.values)).toMatchObject([{ candidateCaseId, partyId: partyA }]);
      expect(subject.updates).toHaveLength(0);
    }),
);
for (const created of [true, false]) {
  it.effect(
    `retail acceptance ${created ? 'emits its single real Party event' : 'does not re-emit creation on a recovered resolution'}`,
    () =>
      Effect.gen(function* eventOnce() {
        const native = yield* makeActionTestHarness();
        const collector = createActionCollector(
          acceptRetailEnrollmentEvidenceAction.descriptor.domainEvents,
          'party.registry',
          acceptRetailEnrollmentEvidenceAction.descriptor.accessEvidencePolicy,
        );
        const result = yield* getActionHandler(acceptRetailEnrollmentEvidenceAction)(
          {
            evidence: retailEvidence,
            originalInvocationId: (yield* Schema.decodeEffect(RetailEnrollmentEvidenceSchema)(retailEvidence))
              .providerOwnerInvocationId,
          },
          {
            ...collector,
            actionInvocationId,
            compositionRevision: 'a'.repeat(64),
            scope: {
              authMethod: 'system',
              correlationId: 'retail-events',
              principalId,
              tenantId,
              legalEntityId: partyB,
            },
            services: {
              accept: () =>
                Effect.succeed({
                  created,
                  result: {
                    outcome: 'CREATED',
                    partyRef: makePartyRef(tenantId, partyA),
                    decisionRef: {
                      moduleId: 'party.registry',
                      resourceId: decisionId,
                      resourceType: 'party.registry.party-match-decision',
                      tenantId,
                    },
                  },
                }),
            },
          },
        ).pipe(Effect.provideService(ActionRuntime, native.runtime));
        expect(result).toMatchObject({ outcome: 'CREATED' });
        expect(collector.snapshot().domainEvents).toHaveLength(created ? 1 : 0);
        expect(collector.snapshot().outboxMessages).toHaveLength(created ? 1 : 0);
      }),
  );
}

const retailScope = {
  authBindingId: actionInvocationId,
  authContextRef: 'better-auth-session:retail-native-owner',
  authMethod: 'session' as const,
  correlationId: 'retail-native-owner',
  legalEntityId: partyB,
  principalId,
  tenantId,
};
for (const scenario of [
  'owned',
  'wrong-caller',
  'wrong-tenant',
  'wrong-company',
  'wrong-attestation-company',
  'missing-invocation',
] as const) {
  it.effect(`native retail evidence acceptance checks original invocation ownership: ${scenario}`, () =>
    Effect.gen(function* nativeOwnership() {
      const native = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        tenantPermission: 'allowed',
        legalEntityAccess: 'allowed',
        services: [
          bindActionTestServices(createPartyAction, {
            createOrMatch: () =>
              Effect.succeed({
                outcome: 'CREATED',
                partyRef: makePartyRef(tenantId, partyA),
                decisionRef: {
                  moduleId: 'party.registry',
                  resourceId: decisionId,
                  resourceType: 'party.registry.party-match-decision',
                  tenantId,
                },
              }),
          }),
        ],
      });
      yield* native.runtime.runAction({
        registration: createPartyAction,
        payload: { candidate: { ...retailCandidate, validFrom: DateTime.formatIso(retailCandidate.validFrom) } },
        principal: retailScope,
        transport: { correlationId: 'retail-native-owner', idempotencyKey: 'original-retail-create' },
      });
      const [invocation] = native.snapshot().invocations;
      if (invocation === undefined) {
        throw new Error('Native Create invocation was not recorded');
      }
      const scope = { ...retailScope };
      if (scenario === 'wrong-caller') {
        scope.principalId = yield* Schema.decodeEffect(PrincipalIdSchema)(partyA);
      }
      if (scenario === 'wrong-tenant') {
        scope.tenantId = yield* Schema.decodeEffect(TenantIdSchema)(partyA);
      }
      if (scenario === 'wrong-company') {
        scope.legalEntityId = partyA;
      }
      const subject = harness(
        new Map<unknown, readonly Rows[]>([
          [
            partyMatchDecisions,
            [
              [
                {
                  ...originalCreateDecision,
                  committedCreateOutcome: 'CREATED',
                  outcome: 'CREATED',
                  candidateCaseId: null,
                  partyId: partyA,
                },
              ],
            ],
          ],
        ]),
      );
      // SAFETY: the private factory delegates to the same select/insert/update seam implemented by this harness.
      const transaction = subject.transaction as Parameters<ReturnType<typeof getActionServiceFactory>>[0];
      const services = yield* getActionServiceFactory(acceptRetailEnrollmentEvidenceAction)(
        transaction,
        scope,
        'a'.repeat(64),
      ).pipe(Effect.provideService(ActionRuntime, native.runtime));
      const result = yield* services
        .accept(
          {
            evidence:
              scenario === 'wrong-attestation-company'
                ? { ...retailEvidence, sellingLegalEntityId: partyA }
                : retailEvidence,
            originalInvocationId: (yield* Schema.decodeEffect(RetailEnrollmentEvidenceSchema)({
              ...retailEvidence,
              providerOwnerInvocationId: scenario === 'missing-invocation' ? decisionId : invocation.actionInvocationId,
            })).providerOwnerInvocationId,
          },
          principalId,
        )
        .pipe(Effect.result);
      expect(Result.isSuccess(result)).toBe(scenario === 'owned');
      expect(subject.reads.length).toBe(scenario === 'owned' ? 2 : 0);
      expect(subject.inserts).toHaveLength(0);
    }),
  );
}
for (const actionPermission of ['allowed', 'denied'] as const) {
  it.effect(`retail acceptance requires explicit executor and identity permissions: executor ${actionPermission}`, () =>
    Effect.gen(function* narrowGrant() {
      let called = false;
      const native = yield* makeActionTestHarness({
        actionPermission,
        tenantPermission: actionPermission === 'allowed' ? 'denied' : 'allowed',
        legalEntityAccess: 'allowed',
        services: [
          bindActionTestServices(acceptRetailEnrollmentEvidenceAction, {
            accept: () =>
              Effect.sync(() => {
                called = true;
                return {
                  created: false,
                  result: {
                    caseRef: makeDuplicateCandidateCaseRef(tenantId, candidateCaseId),
                    decisionRef: {
                      moduleId: 'party.registry',
                      resourceId: decisionId,
                      resourceType: 'party.registry.party-match-decision',
                      tenantId,
                    },
                    outcome: 'AMBIGUOUS' as const,
                  },
                };
              }),
          }),
        ],
      });
      expect(
        yield* native.runtime
          .runAction({
            registration: acceptRetailEnrollmentEvidenceAction,
            payload: { evidence: retailEvidence, originalInvocationId: retailEvidence.providerOwnerInvocationId },
            principal: retailScope,
            transport: { correlationId: 'retail-permission', idempotencyKey: 'retail-permission' },
          })
          .pipe(Effect.isFailure, Effect.provideService(ActionRuntime, native.runtime)),
      ).toBe(true);
      expect(called).toBe(false);
      expect(native.snapshot().committed).toHaveLength(0);
    }),
  );
}
