import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime, Effect } from 'effect';
import type { SQL } from 'drizzle-orm';
import type { AresAppliedEvidence } from '../../shared/domain/ares-application.ts';
import { PgDialect } from 'drizzle-orm/pg-core';
import { tenantIdentityWriteLockKey } from '../../src/services/party-identifier-claim.service.ts';
import type {
  PartyRecord,
  PartyOfficialIdentifierRecord,
  parties,
  partyFactAssertions,
  duplicateCandidateCases,
  duplicateCandidateCaseParties,
  partyMatchDecisions,
} from '../../src/db/schema.ts';
import {
  classifyUnarchiveClaimOwners,
  endedPartyFactTransition,
  insertPartyRecord,
  reconcilePartyIdentifierClaims,
  transitionPartyRecord,
  unarchivePartyRecord,
  unarchivePartyWithReview,
  updatePartyIdentityRecord,
} from '../../src/services/party-identity-persistence.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const partyId = '22222222-2222-4222-8222-222222222222';
const firstOwnerId = '33333333-3333-4333-8333-333333333333';
const secondOwnerId = '44444444-4444-4444-8444-444444444444';
const officialIdentifierId = '55555555-5555-4555-8555-555555555555';
const instantAsDate = (instant: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(instant));
const appliedEvidence: AresAppliedEvidence = {
  authorityPolicyKey: 'party_registry.ares_enrichment',
  authorityPolicyVersion: '1',
  cacheAgeSeconds: 0,
  decidedAt: '2026-01-01T00:00:00.000Z',
  evidenceRef: 'ares:27074358:accepted',
  fact: 'BUSINESS_NAME',
  observedAt: '2026-01-01T00:00:00.000Z',
  outcome: 'APPLY_ENRICHMENT',
  provider: 'ares',
  providerChangedOn: null,
  providerRecordRef: '27074358',
  queryIco: '27074358',
  reasonCode: 'selected_missing_fact_confirmed',
  servedAt: '2026-01-01T00:00:00.000Z',
};

const partyRow = (overrides: Partial<PartyRecord> = {}) => ({
  archivedAt: instantAsDate('2026-01-01T00:00:00.000Z'),
  createdAt: instantAsDate('2025-01-01T00:00:00.000Z'),
  currentDisplayName: 'Archived organization',
  currentType: 'ORGANIZATION',
  partyId,
  revision: 4,
  tenantId,
  updatedAt: instantAsDate('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const identifierRow = (overrides: Partial<PartyOfficialIdentifierRecord> = {}) => ({
  identifierTypeKey: 'ICO',
  isCurrent: true,
  namespace: 'CZ:ICO',
  normalizedValue: '27074358',
  officialIdentifierId,
  partyId,
  state: 'ACTIVE',
  tenantId,
  validTo: null,
  verificationState: 'VERIFIED',
  ...overrides,
});

/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-chained-type-assertions, unicorn/no-thenable -- This local test double deliberately models Drizzle's overloaded thenable query boundary; no untrusted input enters it. */
const transactionHarness = (
  selectResponses: readonly unknown[][],
  updateResponses: readonly unknown[][] = [],
  insertResponses: readonly unknown[][] = [],
) => {
  const queuedSelects = [...selectResponses];
  const queuedUpdates = [...updateResponses];
  const queuedInserts = [...insertResponses];
  const insertedValues: unknown[] = [];
  const updateSets: unknown[] = [];
  const selectSelections: unknown[] = [];
  const deletedTargets: unknown[] = [];

  const query = (take: () => unknown) => {
    const chain = {
      for: () => chain,
      from: () => chain,
      innerJoin: () => chain,
      limit: () => chain,
      orderBy: () => chain,
      returning: () => chain,
      set: (value: unknown) => {
        updateSets.push(value);
        return chain;
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(take()).then(resolve),
      where: () => chain,
    };
    return chain;
  };
  // SAFETY: The harness implements exactly the select/insert/update fluent methods exercised by the scoped service under test.
  const transaction = {
    delete: (target: unknown) => {
      deletedTargets.push(target);
      return query(() => []);
    },
    insert: () => ({
      values: (value: unknown) => {
        insertedValues.push(value);
        return query(() => queuedInserts.shift() ?? []);
      },
    }),
    select: (selection: unknown) => {
      selectSelections.push(selection);
      // eslint-disable-next-line anti-slop/no-runtime-typeof -- The overloaded local Drizzle test double distinguishes SQL lock selections from ordinary query selections.
      if (selection !== null && typeof selection === 'object' && 'lock' in selection) {
        // SAFETY: All lock selections emitted by these owner services contain a Drizzle SQL expression.
        const lockQuery = new PgDialect().sqlToQuery(selection.lock as SQL);
        if (lockQuery.params[0] === tenantIdentityWriteLockKey(tenantId)) {
          return query(() => []);
        }
      }
      return query(() => queuedSelects.shift() ?? []);
    },
    update: () => query(() => queuedUpdates.shift() ?? []),
  } as unknown as Parameters<typeof unarchivePartyRecord>[0];
  return { deletedTargets, insertedValues, selectSelections, transaction, updateSets };
};
/* eslint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-chained-type-assertions, unicorn/no-thenable */

const assertTenantLockIsFirst = (harness: ReturnType<typeof transactionHarness>) => {
  // SAFETY: Every service under test first calls the tenant lock with one Drizzle SQL lock selection.
  const selection = harness.selectSelections[0] as { readonly lock: SQL };
  const query = new PgDialect().sqlToQuery(selection.lock);
  assert.match(query.sql, /pg_advisory_xact_lock/u);
  assert.deepEqual(query.params, [tenantIdentityWriteLockKey(tenantId)]);
};

test('ended Party facts are made non-current as part of the same transition', () => {
  assert.deepEqual(endedPartyFactTransition, { isCurrent: false, state: 'ENDED' });
});

test('unnamed Party insertion persists no fabricated display-name assertion', () =>
  Effect.runPromise(
    Effect.gen(function* verifyIdentityPersistence() {
      const candidateEvidence: AresAppliedEvidence = {
        ...appliedEvidence,
        fact: 'PARTY_CANDIDATE',
      };
      const harness = transactionHarness(
        [],
        [],
        [[partyRow({ archivedAt: null, currentDisplayName: null })], []],
      );
      const result = yield* insertPartyRecord(
        harness.transaction,
        tenantId,
        {
          evidenceRefs: ['source:official-record'],
          officialIdentifiers: [
            { identifierType: 'ICO', value: '27074358', verification: 'VERIFIED' },
          ],
          partyType: 'ORGANIZATION',
          provenance: {
            externalEvidence: candidateEvidence,
            method: 'IMPORT',
            source: 'official-register',
          },
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
          validFrom: '2026-01-01T00:00:00.000Z',
        },
        {
          actionInvocationId: '66666666-6666-4666-8666-666666666666',
          policyVersion: 'party-identity.v1',
          principalId: '77777777-7777-4777-8777-777777777777',
        },
      );
      assert.equal(result.displayName, null);
      assertTenantLockIsFirst(harness);
      // SAFETY: The first insert captured by insertPartyRecord targets the parties table.
      assert.equal(
        (harness.insertedValues[0] as typeof parties.$inferInsert).currentDisplayName,
        null,
      );
      // SAFETY: The second insert captured by insertPartyRecord targets the typed fact-assertion table.
      const assertions = harness
        .insertedValues[1] as readonly (typeof partyFactAssertions.$inferInsert)[];
      assert.deepEqual(
        assertions.map((assertion) => assertion.factKind),
        ['PARTY_TYPE'],
      );
      assert.deepEqual(assertions[0]?.externalEvidence, candidateEvidence);
    }),
  ));

test('identity updates close the preceding assertion before accepting its replacement', () =>
  Effect.runPromise(
    Effect.gen(function* verifyIdentityPersistence() {
      const current = partyRow({ archivedAt: null });
      const harness = transactionHarness(
        [[current], [], [{ partyId }]],
        [[{ ...current, currentDisplayName: 'New name', revision: 5 }], []],
      );

      const result = yield* updatePartyIdentityRecord(harness.transaction, tenantId, {
        actionInvocationId: '66666666-6666-4666-8666-666666666666',
        displayName: 'New name',
        expectedRevision: 4,
        externalEvidence: appliedEvidence,
        partyId,
        principalId: '77777777-7777-4777-8777-777777777777',
        provenanceMethod: 'MANUAL',
        provenanceSource: 'test',
        validFrom: '2026-01-01T00:00:00.000Z',
      });
      assert.equal(result._tag, 'found');
      assertTenantLockIsFirst(harness);
      assert.deepEqual(harness.updateSets[1], {
        isCurrent: false,
        state: 'ENDED',
        validTo: instantAsDate('2026-01-01T00:00:00.000Z'),
      });
      assert.equal(harness.insertedValues.length, 1);
      // SAFETY: The update service inserts only the replacement fact assertions captured here.
      const assertions = harness
        .insertedValues[0] as readonly (typeof partyFactAssertions.$inferInsert)[];
      assert.deepEqual(assertions[0]?.externalEvidence, appliedEvidence);
    }),
  ));

test('unarchive owner classification distinguishes conflict from ambiguity deterministically', () => {
  assert.deepEqual(classifyUnarchiveClaimOwners(partyId, [{}, { partyId }]), {
    _tag: 'available',
  });
  assert.deepEqual(classifyUnarchiveClaimOwners(partyId, [{ partyId: firstOwnerId }]), {
    _tag: 'identity_conflict',
    conflictingPartyId: firstOwnerId,
  });
  assert.deepEqual(
    classifyUnarchiveClaimOwners(partyId, [
      { partyId: secondOwnerId },
      { partyId: firstOwnerId },
      { partyId: secondOwnerId },
    ]),
    {
      _tag: 'identity_ambiguous',
      candidatePartyIds: [firstOwnerId, secondOwnerId],
    },
  );
});

test('future-effective identity updates do not replace current facts early', () =>
  Effect.runPromise(
    Effect.gen(function* verifyIdentityPersistence() {
      const harness = transactionHarness([[partyRow({ archivedAt: null })], [], [{ partyId }]]);
      const result = yield* updatePartyIdentityRecord(harness.transaction, tenantId, {
        actionInvocationId: '66666666-6666-4666-8666-666666666666',
        displayName: 'Future name',
        expectedRevision: 4,
        partyId,
        principalId: '77777777-7777-4777-8777-777777777777',
        provenanceMethod: 'MANUAL',
        provenanceSource: 'test',
        validFrom: '2999-01-01T00:00:00.000Z',
      });
      assert.equal(result._tag, 'conflict');
      assert.deepEqual(harness.insertedValues, []);
      assert.deepEqual(harness.updateSets, []);
    }),
  ));

test('unarchive keeps the Party archived when an exact claim belongs to another Party', () =>
  Effect.runPromise(
    Effect.gen(function* verifyIdentityPersistence() {
      const harness = transactionHarness([
        [partyRow()],
        [],
        [{ partyId }],
        [],
        [identifierRow()],
        [{}],
        [{ partyId: firstOwnerId }],
      ]);

      const result = yield* unarchivePartyRecord(harness.transaction, tenantId, partyId, 4);

      assert.deepEqual(result, {
        _tag: 'identity_conflict',
        conflictingPartyId: firstOwnerId,
      });
      assertTenantLockIsFirst(harness);
      assert.deepEqual(harness.insertedValues, []);
      assert.deepEqual(harness.updateSets, []);
    }),
  ));

test('blocked unarchive persists a case and decision without mutating Party, then reuses the case on a fresh attempt', () =>
  Effect.runPromise(
    Effect.gen(function* verifyDurableUnarchiveReview() {
      const candidateCaseId = '66666666-6666-4666-8666-666666666666';
      const decisionId = '77777777-7777-4777-8777-777777777777';
      const caseRow = {
        candidateCaseId,
        candidateFingerprint: 'a'.repeat(64),
        evaluatedEvidence: [
          {
            outcome: 'AMBIGUOUS',
            reason: 'Exact claim conflict',
            ruleKey: 'party-unarchive-review.v1:EXACT_CLAIM_CONFLICT',
          },
        ],
        matchRuleVersion: 'party-exact-claims.v1',
      };
      const harness = transactionHarness(
        [
          [partyRow()],
          [],
          [{ partyId }],
          [],
          [identifierRow()],
          [{}],
          [{ partyId: firstOwnerId }],
          [partyRow()],
          [identifierRow()],
          [],
          [],
        ],
        [],
        [[caseRow], [], [{ matchDecisionId: decisionId }]],
      );
      const result = yield* unarchivePartyWithReview(
        harness.transaction,
        tenantId,
        partyId,
        4,
        decisionId,
      );
      assert.equal(result._tag, 'blocked');
      assertTenantLockIsFirst(harness);
      assert.deepEqual(harness.updateSets, []);
      assert.deepEqual(harness.deletedTargets, []);
      assert.equal(harness.insertedValues.length, 3);
      // SAFETY: These are precisely the case, membership and decision inserts captured from the owner service.
      const persistedCase = harness
        .insertedValues[0] as typeof duplicateCandidateCases.$inferInsert;
      // SAFETY: The second insert is the case's deterministic membership set.
      const members = harness
        .insertedValues[1] as readonly (typeof duplicateCandidateCaseParties.$inferInsert)[];
      // SAFETY: The third insert is the durable Action-linked match decision.
      const decision = harness.insertedValues[2] as typeof partyMatchDecisions.$inferInsert;
      assert.equal(persistedCase.candidateSnapshot.intent, 'UNARCHIVE');
      assert.deepEqual(persistedCase.candidateSnapshot.names, ['Archived organization']);
      assert.equal(
        persistedCase.candidateSnapshot.officialIdentifiers?.[0]?.normalizedValue,
        '27074358',
      );
      assert.match(persistedCase.evaluationFingerprint, /^[0-9a-f]{64}$/u);
      assert.deepEqual(
        members.map((member) => member.partyId),
        [partyId, firstOwnerId],
      );
      assert.equal(decision.actionInvocationId, decisionId);
      assert.equal(decision.candidateCaseId, candidateCaseId);
      assert.equal(decision.outcome, 'AMBIGUOUS');
      if (result._tag === 'blocked') {
        assert.equal(result.value.reasonCode, 'EXACT_CLAIM_CONFLICT');
        assert.equal(result.value.party.archivedAt, '2026-01-01T00:00:00.000Z');
        assert.equal(result.value.party.revision, 4);
      }

      const secondDecisionId = '88888888-8888-4888-8888-888888888888';
      const retryHarness = transactionHarness(
        [[partyRow()], [], [{ partyId }], [{ candidateCaseId }], [partyRow()], [caseRow]],
        [],
        [[{ matchDecisionId: secondDecisionId }]],
      );
      const retry = yield* unarchivePartyWithReview(
        retryHarness.transaction,
        tenantId,
        partyId,
        4,
        secondDecisionId,
      );
      assert.equal(retry._tag, 'blocked');
      assert.equal(retryHarness.insertedValues.length, 1);
      assert.deepEqual(retryHarness.updateSets, []);
      if (result._tag === 'blocked' && retry._tag === 'blocked') {
        assert.deepEqual(retry.value.caseRef, result.value.caseRef);
        assert.notDeepEqual(retry.value.decisionRef, result.value.decisionRef);
        assert.deepEqual(retry.value.party, result.value.party);
      }
    }),
  ));

test('unresolved unnamed unarchive review persists no invented display-name evidence', () =>
  Effect.runPromise(
    Effect.gen(function* verifyUnresolvedUnarchiveReview() {
      const current = partyRow({ currentDisplayName: null, currentType: 'UNRESOLVED' });
      const caseRow = {
        candidateCaseId: firstOwnerId,
        candidateFingerprint: 'b'.repeat(64),
        evaluatedEvidence: [],
        matchRuleVersion: 'party-exact-claims.v1',
      };
      const harness = transactionHarness(
        [[current], [], [{ partyId }], [], [], [current], [], [], []],
        [],
        [[caseRow], [], [{ matchDecisionId: secondOwnerId }]],
      );
      const result = yield* unarchivePartyWithReview(
        harness.transaction,
        tenantId,
        partyId,
        4,
        secondOwnerId,
      );
      assert.equal(result._tag, 'blocked');
      // SAFETY: The first captured insert is the immutable candidate case.
      const persistedCase = harness
        .insertedValues[0] as typeof duplicateCandidateCases.$inferInsert;
      assert.deepEqual(persistedCase.candidateSnapshot.names, []);
      assert.deepEqual(persistedCase.candidateSnapshot.officialIdentifiers, []);
      assert.deepEqual(harness.updateSets, []);
      if (result._tag === 'blocked') {
        assert.equal(result.value.reasonCode, 'UNRESOLVED_IDENTITY');
      }
    }),
  ));

test('archive acquires the tenant identity lock before any Party row lock', () =>
  Effect.runPromise(
    Effect.gen(function* verifyIdentityPersistence() {
      const harness = transactionHarness([[]]);
      const result = yield* transitionPartyRecord(
        harness.transaction,
        tenantId,
        partyId,
        4,
        'ARCHIVED',
      );
      assert.equal(result._tag, 'not_found');
      assertTenantLockIsFirst(harness);
    }),
  ));

test('unarchive restores an unclaimed eligible identifier before activating the Party', () =>
  Effect.runPromise(
    Effect.gen(function* verifyIdentityPersistence() {
      const activeParty = partyRow({ archivedAt: null, revision: 5 });
      const harness = transactionHarness(
        [[partyRow()], [], [{ partyId }], [], [identifierRow()], [{}], []],
        [[activeParty]],
      );

      const result = yield* unarchivePartyRecord(harness.transaction, tenantId, partyId, 4);

      assert.equal(result._tag, 'found');
      assert.deepEqual(harness.insertedValues, [
        [
          {
            identifierTypeKey: 'ICO',
            namespace: 'CZ:ICO',
            normalizedValue: '27074358',
            officialIdentifierId,
            partyId,
            tenantId,
          },
        ],
      ]);
      assert.equal(harness.updateSets.length, 1);
      // SAFETY: Unarchive's only update targets the parties table; the harness captures its exact set value.
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(harness.updateSets[0] as Partial<PartyRecord>).filter(
            ([key]) => key !== 'updatedAt',
          ),
        ),
        { archivedAt: null, revision: 5 },
      );
    }),
  ));

test('unarchive rejects an alias rather than forwarding the write to its survivor', () =>
  Effect.runPromise(
    Effect.gen(function* verifyIdentityPersistence() {
      const harness = transactionHarness([
        [partyRow()],
        [{ aliasPartyId: partyId, canonicalPartyId: firstOwnerId, tenantId }],
        [],
        [{ partyId: firstOwnerId }],
      ]);

      const error = yield* Effect.flip(
        unarchivePartyRecord(harness.transaction, tenantId, partyId, 4),
      );
      assert.equal(error._tag, 'PartyAliasWriteRejected');
      assert.deepEqual(harness.insertedValues, []);
      assert.deepEqual(harness.updateSets, []);
    }),
  ));

test('unarchive reports ambiguous exact claims without changing archived state', () =>
  Effect.runPromise(
    Effect.gen(function* verifyIdentityPersistence() {
      const harness = transactionHarness([
        [partyRow()],
        [],
        [{ partyId }],
        [],
        [
          identifierRow(),
          identifierRow({
            identifierTypeKey: 'CZ_DIC',
            namespace: 'CZ:DIC',
            normalizedValue: 'CZ27074358',
          }),
        ],
        [{}],
        [{}],
        [{ partyId: firstOwnerId }],
        [{ partyId: secondOwnerId }],
      ]);

      const result = yield* unarchivePartyRecord(harness.transaction, tenantId, partyId, 4);
      assert.deepEqual(result, {
        _tag: 'identity_ambiguous',
        candidatePartyIds: [firstOwnerId, secondOwnerId],
      });
      assert.deepEqual(harness.insertedValues, []);
      assert.deepEqual(harness.updateSets, []);
    }),
  ));

test('unarchive does not promote a PERSON ICO into an exclusive strong claim', () =>
  Effect.runPromise(
    Effect.gen(function* verifyIdentityPersistence() {
      const currentParty = partyRow({ currentType: 'PERSON' });
      const harness = transactionHarness(
        [[currentParty], [], [{ partyId }], [], [identifierRow()]],
        [[{ ...currentParty, archivedAt: null, revision: 5 }]],
      );

      const result = yield* unarchivePartyRecord(harness.transaction, tenantId, partyId, 4);
      assert.equal(result._tag, 'found');
      assert.deepEqual(harness.insertedValues, []);
      assert.equal(harness.updateSets.length, 1);
    }),
  ));

test('unarchive requires review while a duplicate case involving the Party remains open', () =>
  Effect.runPromise(
    Effect.gen(function* verifyIdentityPersistence() {
      const caseId = '88888888-8888-4888-8888-888888888888';
      const harness = transactionHarness([
        [partyRow()],
        [],
        [{ partyId }],
        [{ candidateCaseId: caseId }],
      ]);
      const result = yield* unarchivePartyRecord(harness.transaction, tenantId, partyId, 4);
      assert.deepEqual(result, {
        _tag: 'review_required',
        caseIds: [caseId],
        reasonCode: 'OPEN_DUPLICATE_CASE',
      });
      assert.deepEqual(harness.insertedValues, []);
      assert.deepEqual(harness.updateSets, []);
    }),
  ));

test('unarchive requires review for unresolved identity without any eligible strong claim', () =>
  Effect.runPromise(
    Effect.gen(function* verifyIdentityPersistence() {
      const harness = transactionHarness([
        [partyRow({ currentType: 'UNRESOLVED' })],
        [],
        [{ partyId }],
        [],
        [],
      ]);
      const result = yield* unarchivePartyRecord(harness.transaction, tenantId, partyId, 4);
      assert.deepEqual(result, {
        _tag: 'review_required',
        caseIds: [],
        reasonCode: 'UNRESOLVED_IDENTITY',
      });
      assert.deepEqual(harness.insertedValues, []);
      assert.deepEqual(harness.updateSets, []);
    }),
  ));

test('reviewed UNRESOLVED Party can unarchive using retained accepted creation evidence', () =>
  Effect.runPromise(
    Effect.gen(function* restoreReviewedUnresolved() {
      const current = partyRow({ currentType: 'UNRESOLVED' });
      const harness = transactionHarness(
        [
          [current],
          [],
          [{ partyId }],
          [],
          [{ candidateCaseId: '88888888-8888-4888-8888-888888888888' }],
          [],
          [],
        ],
        [[{ ...current, archivedAt: null, revision: 5 }]],
      );
      const result = yield* unarchivePartyRecord(harness.transaction, tenantId, partyId, 4);
      assert.equal(result._tag, 'found');
      assert.equal(harness.updateSets.length, 1);
      assert.deepEqual(harness.insertedValues, []);
    }),
  ));

test('Party type enrichment refuses another owner of a newly eligible identifier', () =>
  Effect.runPromise(
    Effect.gen(function* preventEnrichmentCollision() {
      const current = partyRow({ archivedAt: null, currentType: 'UNRESOLVED' });
      const harness = transactionHarness([
        [current],
        [],
        [{ partyId }],
        [],
        [identifierRow()],
        [{}],
        [{ partyId: firstOwnerId }],
      ]);
      const result = yield* updatePartyIdentityRecord(harness.transaction, tenantId, {
        actionInvocationId: '66666666-6666-4666-8666-666666666666',
        expectedRevision: 4,
        partyId,
        partyType: 'ORGANIZATION',
        principalId: '77777777-7777-4777-8777-777777777777',
        provenanceMethod: 'MANUAL',
        provenanceSource: 'test',
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
        validFrom: '2026-01-01T00:00:00.000Z',
      });
      assert.equal(result._tag, 'conflict');
      assert.deepEqual(harness.insertedValues, []);
      assert.deepEqual(harness.updateSets, []);
      assert.deepEqual(harness.deletedTargets, []);
    }),
  ));

test('Party type enrichment atomically claims identifiers that newly qualify', () =>
  Effect.runPromise(
    Effect.gen(function* claimEnrichedIdentifier() {
      const current = partyRow({ archivedAt: null, currentType: 'UNRESOLVED' });
      const harness = transactionHarness(
        [[current], [], [{ partyId }], [], [identifierRow()], [{}], [], []],
        [[{ ...current, currentType: 'ORGANIZATION', revision: 5 }], []],
      );
      const result = yield* updatePartyIdentityRecord(harness.transaction, tenantId, {
        actionInvocationId: '66666666-6666-4666-8666-666666666666',
        expectedRevision: 4,
        partyId,
        partyType: 'ORGANIZATION',
        principalId: '77777777-7777-4777-8777-777777777777',
        provenanceMethod: 'MANUAL',
        provenanceSource: 'test',
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
        validFrom: '2026-01-01T00:00:00.000Z',
      });
      assert.equal(result._tag, 'found');
      assert.deepEqual(harness.insertedValues[0], [
        {
          identifierTypeKey: 'ICO',
          namespace: 'CZ:ICO',
          normalizedValue: '27074358',
          officialIdentifierId,
          partyId,
          tenantId,
        },
      ]);
      assert.equal(harness.updateSets.length, 2);
    }),
  ));

test('type correction reconciliation releases an ICO claim no longer eligible for a PERSON', () =>
  Effect.runPromise(
    Effect.gen(function* releaseIneligibleClaim() {
      const harness = transactionHarness([
        [identifierRow()],
        [
          {
            identifierClaimId: '99999999-9999-4999-8999-999999999999',
            identifierTypeKey: 'ICO',
            namespace: 'CZ:ICO',
            normalizedValue: '27074358',
            officialIdentifierId,
            partyId,
            tenantId,
          },
        ],
      ]);
      const result = yield* reconcilePartyIdentifierClaims(
        harness.transaction,
        tenantId,
        partyId,
        'PERSON',
      );
      assert.deepEqual(result, { _tag: 'available', eligibleClaimCount: 0 });
      assert.equal(harness.deletedTargets.length, 1);
      assert.deepEqual(harness.insertedValues, []);
      assertTenantLockIsFirst(harness);
    }),
  ));

test('identity updates reject a historical end earlier than the assertion being replaced', () =>
  Effect.runPromise(
    Effect.gen(function* rejectInvalidHistoricalInterval() {
      const harness = transactionHarness([
        [partyRow({ archivedAt: null })],
        [],
        [{ partyId }],
        [{ validFrom: instantAsDate('2026-05-01T00:00:00.000Z') }],
      ]);
      const result = yield* updatePartyIdentityRecord(harness.transaction, tenantId, {
        actionInvocationId: '66666666-6666-4666-8666-666666666666',
        displayName: 'Historical name',
        expectedRevision: 4,
        partyId,
        principalId: '77777777-7777-4777-8777-777777777777',
        provenanceMethod: 'MANUAL',
        provenanceSource: 'test',
        validFrom: '2026-01-01T00:00:00.000Z',
      });
      assert.equal(result._tag, 'conflict');
      assert.deepEqual(harness.insertedValues, []);
      assert.deepEqual(harness.updateSets, []);
      assert.deepEqual(harness.deletedTargets, []);
    }),
  ));

test('type enrichment rejects unevidenced type before accepting facts or claims', () =>
  Effect.runPromise(
    Effect.gen(function* rejectUnsupportedType() {
      const current = partyRow({ archivedAt: null, currentType: 'UNRESOLVED' });
      const harness = transactionHarness([[current], [], [{ partyId }]]);
      const error = yield* Effect.flip(
        updatePartyIdentityRecord(harness.transaction, tenantId, {
          actionInvocationId: '66666666-6666-4666-8666-666666666666',
          expectedRevision: 4,
          partyId,
          partyType: 'PERSON',
          principalId: '77777777-7777-4777-8777-777777777777',
          provenanceMethod: 'MANUAL',
          provenanceSource: 'review',
          validFrom: '2026-01-01T00:00:00.000Z',
        }),
      );
      assert.equal(error._tag, 'PartyEvidenceInsufficient');
      assert.deepEqual(harness.insertedValues, []);
      assert.deepEqual(harness.updateSets, []);
    }),
  ));
