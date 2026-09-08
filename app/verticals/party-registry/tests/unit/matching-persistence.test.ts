import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

/* eslint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type -- This harness implements the narrow Drizzle Effect boundary exercised by the owner-local matching service. expires: 2026-12-31. */
import type { SQL } from 'drizzle-orm';
import { DateTime, Effect, Layer, Schema, Predicate } from 'effect';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import type { PartyCandidate } from '../../shared/domain/identity-contracts.ts';
import { makePartyRef, partySubjectKeyFromString } from '../../shared/domain/identity-contracts.ts';
import { PartyAliasWriteRejected } from '../../shared/domain/merge-alias-resolution.ts';
import { makeDuplicateCandidateCaseRef } from '../../shared/resources/duplicate-candidate-case.ts';
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
  candidateFingerprint,
  createOrMatchParty,
  matchParty,
  resolveDuplicateCandidateCreate,
  resolveDuplicateCandidateMatch,
} from '../../src/services/party-matching-persistence.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyA = '20000000-0000-4000-8000-000000000001';
const partyB = '20000000-0000-4000-8000-000000000002';
const partyC = '20000000-0000-4000-8000-000000000003';
const candidateCaseId = '30000000-0000-4000-8000-000000000001';
const decisionId = '40000000-0000-4000-8000-000000000001';
const actionInvocationId = '50000000-0000-4000-8000-000000000001';
const principalId = '60000000-0000-4000-8000-000000000001';
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
    const chain = Object.assign(
      Effect.sync(() => []),
      {
        set: (values: Row) => {
          updates.push({ table, values });
          return chain;
        },
        where: () => chain,
      },
    );
    return chain;
  };
  // SAFETY: this test double implements exactly the fluent methods called by the persistence seam.
  const transaction = { insert, select, update } as unknown as Parameters<
    typeof resolveDuplicateCandidateMatch
  >[0];
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
  Layer.effectDiscard(
    TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-01T00:00:00.000Z'))),
  ),
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
        expect(
          subject.reads[0]?.table,
          'tenant serialization lock precedes row/claim reads',
        ).not.toBe(partyIdentifierClaims);
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
              { identifierType: 'ICO', value: '27074358', verification: 'VERIFIED' },
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
        const durable = recordedRow(
          subject.inserts.find(({ table }) => table === partyMatchDecisions)?.values,
        );
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
                      candidateSnapshot: { ...original.candidateSnapshot, intent: 'UNARCHIVE' },
                    },
                  ],
                ],
              ],
            ]),
          );
          const error =
            resolution === 'CREATE'
              ? yield* Effect.flip(
                  resolveDuplicateCandidateCreate(subject.transaction, resolutionInput),
                )
              : yield* Effect.flip(
                  resolveDuplicateCandidateMatch(subject.transaction, resolutionInput),
                );
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
        expect(result.outcome).toBe('MATCHED_EXISTING');
        const durable = recordedRow(
          subject.inserts.find(({ table }) => table === partyMatchDecisions)?.values,
        );
        expect(durable['operation']).toBe('CREATE');
        expect(durable['committedCreateOutcome']).toBe('MATCHED_EXISTING');
        expect(
          'addedOfficialIdentifierRefs' in result,
          'mutation metadata stays private to the Action',
        ).toBe(false);
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
        expect(result.outcome).toBe('MATCH_EXISTING');
        expect('addedOfficialIdentifierRefs' in result).toBe(false);
        const evidence = collector.snapshot();
        expect(evidence.domainEvents.map((event) => event.eventType)).toEqual([
          'party.registry.official-identifier-added.v1',
        ]);
        expect(evidence.outboxMessages.length).toBe(1);
        expect(evidence.outboxMessages[0]?.domainEventIndex).toBe(0);
        expect(evidence.outboxMessages[0]?.message.topic).toBe(
          'party.registry.official-identifier-added.v1',
        );
        expect(evidence.outboxMessages[0]?.message.payloadJson).toEqual(
          evidence.domainEvents[0]?.payloadJson,
        );
      }),
  );

  testIt.effect(
    'matched Create reusing an existing identifier does not republish an acceptance event',
    () =>
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
                { identifierType: 'ICO', value: '27074358', verification: 'VERIFIED' },
                { identifierType: 'CZ_DIC', value: 'CZ27074358', verification: 'UNVERIFIED' },
              ],
            }),
          },
          {
            ...collector,
            actionInvocationId,
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
        expect(result.outcome).toBe('MATCHED_EXISTING');
        expect(collector.snapshot().domainEvents).toEqual([]);
        expect(collector.snapshot().outboxMessages).toEqual([]);
        expect(subject.inserts.some(({ table }) => table === partyOfficialIdentifiers)).toBe(false);
      }),
  );

  testIt.effect(
    'repeated Candidate facts accepted in one matching transaction publish one identifier event',
    () =>
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
                { identifierType: 'ICO', value: '27074358', verification: 'VERIFIED' },
                identifier,
                identifier,
              ],
            }),
          },
          {
            ...collector,
            actionInvocationId,
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
        expect(
          subject.inserts.filter(({ table }) => table === partyOfficialIdentifiers).length,
        ).toBe(1);
        expect(collector.snapshot().domainEvents.length).toBe(1);
        expect(collector.snapshot().outboxMessages.length).toBe(1);
      }),
  );

  testIt.effect(
    'reviewed matching with already-owned claims creates no duplicate identifier notifications',
    () =>
      Effect.gen(function* reviewedMatchingWithAlreadyOwnedClaimsCreates() {
        const subject = harness(
          new Map<unknown, readonly Rows[]>([
            [duplicateCandidateCases, [[caseRow()]]],
            [partyAliases, [[], []]],
            [
              parties,
              [[activePartyRow(partyC)], [activePartyRow(partyC)], [activePartyRow(partyC)]],
            ],
            [partyIdentifierClaims, [[{ officialIdentifierId, partyId: partyC }]]],
          ]),
        );
        const { collector, result } = yield* invokeReviewedMatch(subject);
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
        const failure = yield* Effect.flip(
          resolveDuplicateCandidateMatch(subject.transaction, resolutionInput),
        );
        expect(Predicate.isTagged(failure, 'DuplicateCandidateConflict')).toBe(true);
        expect(subject.reads.some(({ table, locked }) => table === parties && locked)).toBe(true);
        expect(subject.inserts).toEqual([]);
        expect(subject.updates).toEqual([]);
      }),
  );

  testIt.effect(
    'reviewed matching rejects a cross-tenant selected reference without resolving its identity',
    () =>
      Effect.gen(function* reviewedMatchingRejectsACrossTenantSelected() {
        const subject = harness();
        const failure = yield* Effect.flip(
          resolveDuplicateCandidateMatch(subject.transaction, {
            ...resolutionInput,
            selectedPartyTenantId: '90000000-0000-4000-8000-000000000001',
          }),
        );
        expect(Predicate.isTagged(failure, 'DuplicateCandidateConflict')).toBe(true);
        expect(subject.reads.length, 'only the trusted tenant serialization lock is acquired').toBe(
          1,
        );
        expect(subject.inserts).toEqual([]);
      }),
  );

  testIt.effect(
    'reviewed matching rejects an absorbed target with the full-chain canonical survivor reference',
    () =>
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

  testIt.effect(
    'future-effective evidence is rejected before a current decision or Party can be persisted',
    () =>
      Effect.gen(function* futureEffectiveEvidenceIsRejectedBeforeA() {
        const subject = harness();
        const failure = yield* Effect.flip(
          matchParty(subject.transaction, {
            actionInvocationId,
            candidate: candidate({ validFrom: DateTime.makeUnsafe('2099-01-01T00:00:00.000Z') }),
            tenantId,
          }),
        );
        expect(Predicate.isTagged(failure, 'PartyEvidenceInsufficient')).toBe(true);
        expect(subject.inserts).toEqual([]);
      }),
  );

  it('durable matching is an idempotent identity Action and the separate UX preview remains a governed read', () => {
    expect(matchPartyAction.descriptor.idempotency).toBe('required');
    expect(matchPartyAction.descriptor.tenantPermission?.({ candidate: candidate() })).toBe(
      'manage_party_identity',
    );
    expect(matchPartyAction.descriptor.legalEntityScope).toBe('optional');
    expect(partyMatchRead.descriptor.accessKind).toBe('detail');
  });

  testIt.effect(
    'weak exact canonical evidence produces review rather than automatic identity or NO_MATCH',
    () =>
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
              { identifierType: 'ICO', value: '27074358', verification: 'UNVERIFIED' },
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

  testIt.effect(
    'a new material evaluation creates a linked successor without rewriting the prior case',
    () =>
      Effect.gen(function* aNewMaterialEvaluationCreatesALinked() {
        const priorId = '30000000-0000-4000-8000-000000000099';
        const subject = harness(
          new Map<unknown, readonly Rows[]>([
            [
              partyIdentifierClaims,
              [
                [{ officialIdentifierId: '70000000-0000-4000-8000-000000000001', partyId: partyA }],
                [{ partyId: partyB }],
              ],
            ],
            [partyAliases, [[], []]],
            [parties, [[{ partyId: partyA }], [{ partyId: partyB }]]],
            [
              duplicateCandidateCases,
              [[], [{ ...caseRow(), candidateCaseId: priorId, lifecycleState: 'RESOLVED' }]],
            ],
          ]),
        );
        const result = yield* matchParty(subject.transaction, {
          actionInvocationId,
          candidate: candidate(),
          tenantId,
        });
        const insertedCase = recordedRow(
          subject.inserts.find(({ table }) => table === duplicateCandidateCases)?.values,
        );
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

  testIt.effect(
    'explicit prior-case continuation rejects foreign or missing review references',
    () =>
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
      provenance: { method: original.provenance.method, source: original.provenance.source },
      subjectEvidence: original.subjectEvidence ?? [],
      validFrom: original.validFrom,
    };
    expect(candidateFingerprint(original)).toBe(candidateFingerprint(reordered));
  });

  testIt.effect(
    'insufficient typed evidence cannot persist a case or decision even with a verified identifier',
    () =>
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

  testIt.effect(
    'reviewer selection cannot waive missing subject/type evidence from a retained case',
    () =>
      Effect.gen(function* denyUnevidencedReview() {
        const row = caseRow();
        const subject = harness(
          new Map([
            [
              duplicateCandidateCases,
              [[{ ...row, candidateSnapshot: { ...row.candidateSnapshot, subjectEvidence: [] } }]],
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
