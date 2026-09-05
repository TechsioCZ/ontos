/* eslint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type, unicorn/no-thenable -- This harness implements the narrow Drizzle PromiseLike boundary exercised by the owner-local matching service. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime, Effect } from 'effect';
import type { SQL } from 'drizzle-orm';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import type { PartyCandidate } from '../../shared/domain/identity-contracts.ts';
import { makePartyRef } from '../../shared/domain/identity-contracts.ts';
import { makeDuplicateCandidateCaseRef } from '../../shared/resources/duplicate-candidate-case.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { resolveDuplicateCandidateMatchAction } from '../../src/actions/resolve-duplicate-candidate-match.action.ts';
import { matchPartyAction } from '../../src/actions/match-party.action.ts';
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
  matchParty,
  candidateFingerprint,
  createOrMatchParty,
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
      subjectKey: 'one-subject',
    },
  ],
  validFrom: instant,
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
  assert.ok(values !== undefined && !Array.isArray(values));
  // SAFETY: the recorded insert was checked to be a present single row rather than a batch.
  return values as Row;
};
const recordedRows = (values: RecordedValues): readonly Row[] => {
  assert.ok(Array.isArray(values));
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
    const chain = {
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
      then: <Result>(onfulfilled?: ((value: Rows) => Result) | null) =>
        Promise.resolve(resolve()).then(onfulfilled),
      where: () => chain,
    };
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
    const chain = {
      returning: () => Promise.resolve(returned()),
      then: <Result>(onfulfilled?: ((value: Rows) => Result) | null) =>
        Promise.resolve(returned()).then(onfulfilled),
      values: (input: Row | readonly Row[]) => {
        values = input;
        inserts.push({ table, values });
        return chain;
      },
    };
    return chain;
  };
  const update = (table: HarnessTable) => {
    const chain = {
      set: (values: Row) => {
        updates.push({ table, values });
        return chain;
      },
      then: <Result>(onfulfilled?: ((value: Rows) => Result) | null) =>
        Promise.resolve([]).then(onfulfilled),
      where: () => chain,
    };
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

test('durable Party Match commits an ambiguity decision, complete case references, and original evidence without mutating a Party', () =>
  Effect.runPromise(
    Effect.gen(function* durablePartyMatchCommitsAnAmbiguityDecision() {
      const subject = ambiguousHarness(false);
      const result = yield* matchParty(subject.transaction, {
        actionInvocationId,
        candidate: candidate(),
        tenantId,
      });
      assert.equal(result.outcome, 'AMBIGUOUS');
      assert.deepEqual(
        result.candidateParties.map((ref) => ref.resourceId),
        [partyA, partyB],
      );
      assert.equal(result.decisionRef.resourceId, decisionId);
      assert.deepEqual(
        subject.inserts.map(({ table }) => table),
        [duplicateCandidateCases, duplicateCandidateCaseParties, partyMatchDecisions],
      );
      const caseValues = recordedRow(subject.inserts[0]?.values);
      // SAFETY: this fixture records the concrete candidateSnapshot inserted by the matching service.
      const snapshot = caseValues['candidateSnapshot'] as Row;
      assert.deepEqual(snapshot['names'], []);
      assert.deepEqual(snapshot['provenance'], candidate().provenance);
      assert.equal(snapshot['validFrom'], instant);
      const linked = recordedRows(subject.inserts[1]?.values);
      assert.deepEqual(
        linked.map((row) => [row['partyId'], row['rank']]),
        [
          [partyA, 1],
          [partyB, 2],
        ],
      );
      assert.equal(recordedRow(subject.inserts[2]?.values)['candidateCaseId'], candidateCaseId);
      assert.equal(subject.updates.length, 0);
      assert.notEqual(
        subject.reads[0]?.table,
        partyIdentifierClaims,
        'tenant serialization lock precedes row/claim reads',
      );
    }),
  ));

test('an unchanged open ambiguity reuses its immutable evaluated case without rewriting candidate links', () =>
  Effect.runPromise(
    Effect.gen(function* anUnchangedOpenAmbiguityReusesItsImmutable() {
      const subject = ambiguousHarness(true);
      yield* matchParty(subject.transaction, {
        actionInvocationId,
        candidate: candidate(),
        tenantId,
      });
      assert.deepEqual(
        subject.inserts.map(({ table }) => table),
        [partyMatchDecisions],
      );
      assert.equal(subject.updates.length, 0, 'the original case snapshot is never overwritten');
    }),
  ));

test('PERSON IČO cannot acquire organization auto-match authority and NO_MATCH still records a decision', () =>
  Effect.runPromise(
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
              subjectKey: 'one-subject',
            },
          ],
        }),
        tenantId,
      });
      assert.equal(result.outcome, 'NO_MATCH');
      const durable = recordedRow(
        subject.inserts.find(({ table }) => table === partyMatchDecisions)?.values,
      );
      assert.equal(durable['operation'], 'MATCH');
      assert.equal(durable['committedCreateOutcome'], null);
      assert.deepEqual(result.candidateParties, []);
      assert.deepEqual(
        subject.inserts.map(({ table }) => table),
        [partyMatchDecisions],
      );
      assert.equal(
        subject.reads.some(({ table }) => table === partyIdentifierClaims),
        false,
      );
    }),
  ));

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

test('an unarchive review cannot create a replacement Party or attach its facts through Candidate matching', () =>
  Effect.runPromise(
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
        assert.equal(error._tag, 'DuplicateCandidateConflict');
        assert.match(error.reason, /unarchive/iu);
        assert.deepEqual(subject.inserts, []);
        assert.deepEqual(subject.updates, []);
      }
    }),
  ));

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

test('Create Party matching an existing subject publishes each newly accepted identifier without fabricating Party Created', () =>
  Effect.runPromise(
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
      assert.equal(result.outcome, 'MATCHED_EXISTING');
      const durable = recordedRow(
        subject.inserts.find(({ table }) => table === partyMatchDecisions)?.values,
      );
      assert.equal(durable['operation'], 'CREATE');
      assert.equal(durable['committedCreateOutcome'], 'MATCHED_EXISTING');
      assert.equal(
        'addedOfficialIdentifierRefs' in result,
        false,
        'mutation metadata stays private to the Action',
      );
      const evidence = collector.snapshot();
      assert.deepEqual(
        evidence.domainEvents.map((event) => event.eventType),
        ['party.registry.official-identifier-added.v1'],
      );
      assert.equal(evidence.outboxMessages.length, 1);
      assert.equal(evidence.outboxMessages[0]?.domainEventIndex, 0);
      assert.deepEqual(evidence.outboxMessages[0]?.message.payloadJson, {
        officialIdentifierRef: {
          moduleId: 'party.registry',
          resourceId: officialIdentifierId,
          resourceType: 'party.registry.party-official-identifier',
          tenantId,
        },
        partyRef: makePartyRef(tenantId, partyA),
      });
    }),
  ));

test('reviewed matching publishes the accepted identifier through its declared Action event and linked outbox', () =>
  Effect.runPromise(
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
      assert.equal(result.outcome, 'MATCH_EXISTING');
      assert.equal('addedOfficialIdentifierRefs' in result, false);
      const evidence = collector.snapshot();
      assert.deepEqual(
        evidence.domainEvents.map((event) => event.eventType),
        ['party.registry.official-identifier-added.v1'],
      );
      assert.equal(evidence.outboxMessages.length, 1);
      assert.equal(evidence.outboxMessages[0]?.domainEventIndex, 0);
      assert.equal(
        evidence.outboxMessages[0]?.message.topic,
        'party.registry.official-identifier-added.v1',
      );
      assert.deepEqual(
        evidence.outboxMessages[0]?.message.payloadJson,
        evidence.domainEvents[0]?.payloadJson,
      );
    }),
  ));

test('matched Create reusing an existing identifier does not republish an acceptance event', () =>
  Effect.runPromise(
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
      assert.equal(result.outcome, 'MATCHED_EXISTING');
      assert.deepEqual(collector.snapshot().domainEvents, []);
      assert.deepEqual(collector.snapshot().outboxMessages, []);
      assert.equal(
        subject.inserts.some(({ table }) => table === partyOfficialIdentifiers),
        false,
      );
    }),
  ));

test('repeated Candidate facts accepted in one matching transaction publish one identifier event', () =>
  Effect.runPromise(
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
      assert.equal(
        subject.inserts.filter(({ table }) => table === partyOfficialIdentifiers).length,
        1,
      );
      assert.equal(collector.snapshot().domainEvents.length, 1);
      assert.equal(collector.snapshot().outboxMessages.length, 1);
    }),
  ));

test('reviewed matching with already-owned claims creates no duplicate identifier notifications', () =>
  Effect.runPromise(
    Effect.gen(function* reviewedMatchingWithAlreadyOwnedClaimsCreates() {
      const subject = harness(
        new Map<unknown, readonly Rows[]>([
          [duplicateCandidateCases, [[caseRow()]]],
          [partyAliases, [[], []]],
          [parties, [[activePartyRow(partyC)], [activePartyRow(partyC)], [activePartyRow(partyC)]]],
          [partyIdentifierClaims, [[{ officialIdentifierId, partyId: partyC }]]],
        ]),
      );
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
      assert.equal(result.outcome, 'MATCH_EXISTING');
      assert.deepEqual(collector.snapshot().domainEvents, []);
      assert.deepEqual(collector.snapshot().outboxMessages, []);
    }),
  ));

test('reviewed matching locks and rejects an archived canonical target before any attachment or resolution', () =>
  Effect.runPromise(
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
      assert.equal(failure._tag, 'DuplicateCandidateConflict');
      assert.equal(
        subject.reads.some(({ table, locked }) => table === parties && locked),
        true,
      );
      assert.deepEqual(subject.inserts, []);
      assert.deepEqual(subject.updates, []);
    }),
  ));

test('reviewed matching rejects a cross-tenant selected reference without resolving its identity', () =>
  Effect.runPromise(
    Effect.gen(function* reviewedMatchingRejectsACrossTenantSelected() {
      const subject = harness();
      const failure = yield* Effect.flip(
        resolveDuplicateCandidateMatch(subject.transaction, {
          ...resolutionInput,
          selectedPartyTenantId: '90000000-0000-4000-8000-000000000001',
        }),
      );
      assert.equal(failure._tag, 'DuplicateCandidateConflict');
      assert.equal(
        subject.reads.length,
        1,
        'only the trusted tenant serialization lock is acquired',
      );
      assert.deepEqual(subject.inserts, []);
    }),
  ));

test('reviewed matching rejects an absorbed target with the full-chain canonical survivor reference', () =>
  Effect.runPromise(
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
      assert.equal(failure._tag, 'PartyAliasWriteRejected');
      if (failure._tag === 'PartyAliasWriteRejected') {
        assert.equal(failure.canonicalPartyRef.resourceId, partyC);
      }
      assert.deepEqual(subject.inserts, []);
      assert.deepEqual(subject.updates, []);
    }),
  ));

test('future-effective evidence is rejected before a current decision or Party can be persisted', () =>
  Effect.runPromise(
    Effect.gen(function* futureEffectiveEvidenceIsRejectedBeforeA() {
      const subject = harness();
      const failure = yield* Effect.flip(
        matchParty(subject.transaction, {
          actionInvocationId,
          candidate: candidate({ validFrom: '2099-01-01T00:00:00.000Z' }),
          tenantId,
        }),
      );
      assert.equal(failure._tag, 'PartyEvidenceInsufficient');
      assert.deepEqual(subject.inserts, []);
    }),
  ));

test('durable matching is an idempotent identity Action and the separate UX preview remains a governed read', () => {
  assert.equal(matchPartyAction.descriptor.idempotency, 'required');
  assert.equal(
    matchPartyAction.descriptor.tenantPermission?.({ candidate: candidate() }),
    'manage_party_identity',
  );
  assert.equal(matchPartyAction.descriptor.legalEntityScope, 'optional');
  assert.equal(partyMatchRead.descriptor.accessKind, 'detail');
});

test('weak exact canonical evidence produces review rather than automatic identity or NO_MATCH', () =>
  Effect.runPromise(
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
              subjectKey: 'one-subject',
            },
          ],
        }),
        tenantId,
      });
      assert.equal(result.outcome, 'AMBIGUOUS');
      assert.equal(result.caseRef?.resourceId, candidateCaseId);
      assert.deepEqual(
        result.candidateParties.map((ref) => ref.resourceId),
        [partyA],
      );
      assert.equal(
        subject.inserts.some(({ table }) => table === parties),
        false,
      );
    }),
  ));

test('initial no-strong Create review captures relevant same-name canonical Parties in its immutable snapshot', () =>
  Effect.runPromise(
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
      assert.equal(result.outcome, 'AMBIGUOUS');
      const links = recordedRows(
        subject.inserts.find(({ table }) => table === duplicateCandidateCaseParties)?.values,
      );
      assert.deepEqual(
        links.map((row) => row['partyId']),
        [partyA],
      );
      assert.equal(
        subject.inserts.some(({ table }) => table === parties),
        false,
      );
    }),
  ));

test('a new material evaluation creates a linked successor without rewriting the prior case', () =>
  Effect.runPromise(
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
      assert.equal(insertedCase['priorCandidateCaseId'], priorId);
      assert.match(String(insertedCase['evaluationFingerprint']), /^[0-9a-f]{64}$/u);
      assert.equal(
        result.evidenceExplanation[0]?.officialIdentifierRef?.resourceId,
        '70000000-0000-4000-8000-000000000001',
      );
      assert.equal(result.evidenceExplanation[0]?.identifierType, 'ICO');
      assert.equal(result.evidenceExplanation[0]?.normalizedValue, '27074358');
      assert.deepEqual(subject.updates, []);
    }),
  ));

test('explicit prior-case continuation rejects foreign or missing review references', () =>
  Effect.runPromise(
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
          assert.equal(failure._tag, 'PartyEvidenceInsufficient');
          assert.deepEqual(subject.inserts, []);
        }),
      { concurrency: 'unbounded', discard: true },
    ),
  ));

test('equivalent Candidate property and evidence ordering has one deterministic fingerprint', () => {
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
  assert.equal(candidateFingerprint(original), candidateFingerprint(reordered));
});

test('insufficient typed evidence cannot persist a case or decision even with a verified identifier', () =>
  Effect.runPromise(
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
        assert.equal(failure._tag, 'PartyEvidenceInsufficient');
        assert.equal(subject.inserts.length, 0);
      }
    }),
  ));

test('reviewer selection cannot waive missing subject/type evidence from a retained case', () =>
  Effect.runPromise(
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
      assert.equal(failure._tag, 'DuplicateCandidateConflict');
      assert.equal(subject.inserts.length, 0);
      assert.equal(subject.updates.length, 0);
    }),
  ));
