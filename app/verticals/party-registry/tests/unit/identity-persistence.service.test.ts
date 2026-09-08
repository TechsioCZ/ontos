import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DateTime, Effect, Layer, Match, Option, Result, Schema, Predicate, Struct } from 'effect';

import type { AresAppliedEvidence } from '../../shared/domain/ares-application.ts';
import { AresAppliedEvidenceSchema } from '../../shared/domain/ares-application.ts';
import { partySubjectKeyFromString } from '../../shared/domain/identity-contracts.ts';
import type {
  PartyOfficialIdentifierRecord,
  PartyRecord,
  duplicateCandidateCaseParties,
  duplicateCandidateCases,
  parties,
  partyFactAssertions,
  partyMatchDecisions,
} from '../../src/db/schema.ts';
import { tenantIdentityWriteLockKey } from '../../src/services/party-identifier-claim.service.ts';
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
const appliedEvidence = Result.getOrThrow(
  Schema.decodeUnknownResult(AresAppliedEvidenceSchema)({
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
  }),
);

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

/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-chained-type-assertions -- This local test double deliberately models Drizzle's overloaded thenable query boundary; no untrusted input enters it. expires: 2026-12-31. */
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
    const chain = Object.assign(
      Effect.sync(() => take()),
      {
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
        where: () => chain,
      },
    );
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
/* eslint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-chained-type-assertions */

const assertTenantLockIsFirst = (harness: ReturnType<typeof transactionHarness>) => {
  // SAFETY: Every service under test first calls the tenant lock with one Drizzle SQL lock selection.
  const selection = harness.selectSelections[0] as { readonly lock: SQL };
  const query = new PgDialect().sqlToQuery(selection.lock);
  expect(query.sql).toMatch(/pg_advisory_xact_lock/u);
  expect(query.params).toEqual([tenantIdentityWriteLockKey(tenantId)]);
};

it.layer(
  Layer.effectDiscard(
    TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-01T00:00:00.000Z'))),
  ),
)('identity-persistence.service', (testIt) => {
  it('ended Party facts are made non-current as part of the same transition', () => {
    expect(endedPartyFactTransition).toEqual({ isCurrent: false, state: 'ENDED' });
  });

  testIt.effect('unnamed Party insertion persists no fabricated display-name assertion', () =>
    Effect.gen(function* verifyIdentityPersistence() {
      const candidateEvidence: AresAppliedEvidence = {
        ...appliedEvidence,
        fact: 'PARTY_CANDIDATE',
      };
      const encodedCandidateEvidence =
        yield* Schema.encodeEffect(AresAppliedEvidenceSchema)(candidateEvidence);
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
              subjectKey: partySubjectKeyFromString('one-subject'),
            },
          ],
          validFrom: DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'),
        },
        {
          actionInvocationId: '66666666-6666-4666-8666-666666666666',
          policyVersion: 'party-identity.v1',
          principalId: '77777777-7777-4777-8777-777777777777',
        },
      );
      expect(Option.isNone(result.displayName)).toBe(true);
      assertTenantLockIsFirst(harness);
      // SAFETY: The first insert captured by insertPartyRecord targets the parties table.
      expect((harness.insertedValues[0] as typeof parties.$inferInsert).currentDisplayName).toBe(
        null,
      );
      // SAFETY: The second insert captured by insertPartyRecord targets the typed fact-assertion table.
      const assertions = harness
        .insertedValues[1] as readonly (typeof partyFactAssertions.$inferInsert)[];
      expect(assertions.map((assertion) => assertion.factKind)).toEqual(['PARTY_TYPE']);
      expect(assertions[0]?.externalEvidence).toEqual(encodedCandidateEvidence);
    }),
  );

  testIt.effect(
    'identity updates close the preceding assertion before accepting its replacement',
    () =>
      Effect.gen(function* verifyIdentityPersistence() {
        const current = partyRow({ archivedAt: null });
        const harness = transactionHarness(
          [[current], [], [{ partyId }]],
          [[{ ...current, currentDisplayName: 'New name', revision: 5 }], []],
        );
        const encodedAppliedEvidence =
          yield* Schema.encodeEffect(AresAppliedEvidenceSchema)(appliedEvidence);

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
        expect(Predicate.isTagged(result, 'found')).toBe(true);
        assertTenantLockIsFirst(harness);
        expect(harness.updateSets[1]).toEqual({
          isCurrent: false,
          state: 'ENDED',
          validTo: instantAsDate('2026-01-01T00:00:00.000Z'),
        });
        expect(harness.insertedValues.length).toBe(1);
        // SAFETY: The update service inserts only the replacement fact assertions captured here.
        const assertions = harness
          .insertedValues[0] as readonly (typeof partyFactAssertions.$inferInsert)[];
        expect(assertions[0]?.externalEvidence).toEqual(encodedAppliedEvidence);
      }),
  );

  it('unarchive owner classification distinguishes conflict from ambiguity deterministically', () => {
    const availableOwners = classifyUnarchiveClaimOwners(partyId, [{}, { partyId }]);
    expect(Predicate.isTagged(availableOwners, 'available')).toBe(true);
    expect(Struct.omit(availableOwners, ['_tag'])).toEqual({});
    const conflictingOwner = classifyUnarchiveClaimOwners(partyId, [{ partyId: firstOwnerId }]);
    expect(Predicate.isTagged(conflictingOwner, 'identity_conflict')).toBe(true);
    expect(Struct.omit(conflictingOwner, ['_tag'])).toEqual({
      conflictingPartyId: firstOwnerId,
    });
    const ambiguousOwners = classifyUnarchiveClaimOwners(partyId, [
      { partyId: secondOwnerId },
      { partyId: firstOwnerId },
      { partyId: secondOwnerId },
    ]);
    expect(Predicate.isTagged(ambiguousOwners, 'identity_ambiguous')).toBe(true);
    expect(Struct.omit(ambiguousOwners, ['_tag'])).toEqual({
      candidatePartyIds: [firstOwnerId, secondOwnerId],
    });
  });

  testIt.effect('future-effective identity updates do not replace current facts early', () =>
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
      expect(Predicate.isTagged(result, 'conflict')).toBe(true);
      expect(harness.insertedValues).toEqual([]);
      expect(harness.updateSets).toEqual([]);
    }),
  );

  testIt.effect(
    'unarchive keeps the Party archived when an exact claim belongs to another Party',
    () =>
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

        expect(Predicate.isTagged(result, 'identity_conflict')).toBe(true);
        expect(Struct.omit(result, ['_tag'])).toEqual({
          conflictingPartyId: firstOwnerId,
        });
        assertTenantLockIsFirst(harness);
        expect(harness.insertedValues).toEqual([]);
        expect(harness.updateSets).toEqual([]);
      }),
  );

  testIt.effect(
    'blocked unarchive persists a case and decision without mutating Party, then reuses the case on a fresh attempt',
    () =>
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
        expect(Predicate.isTagged(result, 'blocked')).toBe(true);
        const blocked = Match.value(result).pipe(
          Match.tag('blocked', ({ value }) => value),
          Match.orElse(() =>
            (() => {
              throw new Error('Expected unarchive to be blocked');
            })(),
          ),
        );
        assertTenantLockIsFirst(harness);
        expect(harness.updateSets).toEqual([]);
        expect(harness.deletedTargets).toEqual([]);
        expect(harness.insertedValues.length).toBe(3);
        // SAFETY: These are precisely the case, membership and decision inserts captured from the owner service.
        const persistedCase = harness
          .insertedValues[0] as typeof duplicateCandidateCases.$inferInsert;
        // SAFETY: The second insert is the case's deterministic membership set.
        const members = harness
          .insertedValues[1] as readonly (typeof duplicateCandidateCaseParties.$inferInsert)[];
        // SAFETY: The third insert is the durable Action-linked match decision.
        const decision = harness.insertedValues[2] as typeof partyMatchDecisions.$inferInsert;
        expect(persistedCase.candidateSnapshot.intent).toBe('UNARCHIVE');
        expect(persistedCase.candidateSnapshot.names).toEqual(['Archived organization']);
        expect(persistedCase.candidateSnapshot.officialIdentifiers?.[0]?.normalizedValue).toBe(
          '27074358',
        );
        expect(persistedCase.evaluationFingerprint).toMatch(/^[0-9a-f]{64}$/u);
        expect(members.map((member) => member.partyId)).toEqual([partyId, firstOwnerId]);
        expect(decision.actionInvocationId).toBe(decisionId);
        expect(decision.candidateCaseId).toBe(candidateCaseId);
        expect(decision.outcome).toBe('AMBIGUOUS');
        expect(blocked.reasonCode).toBe('EXACT_CLAIM_CONFLICT');
        expect(Option.isSome(blocked.party.archivedAt)).toBe(true);
        expect(DateTime.formatIso(Option.getOrThrow(blocked.party.archivedAt))).toBe(
          '2026-01-01T00:00:00.000Z',
        );
        expect(blocked.party.revision).toBe(4);

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
        expect(Predicate.isTagged(retry, 'blocked')).toBe(true);
        const retryBlocked = Match.value(retry).pipe(
          Match.tag('blocked', ({ value }) => value),
          Match.orElse(() =>
            (() => {
              throw new Error('Expected retry to be blocked');
            })(),
          ),
        );
        expect(retryHarness.insertedValues.length).toBe(1);
        expect(retryHarness.updateSets).toEqual([]);
        expect(retryBlocked.caseRef).toEqual(blocked.caseRef);
        expect(retryBlocked.decisionRef).not.toEqual(blocked.decisionRef);
        expect(retryBlocked.party).toEqual(blocked.party);
      }),
  );

  testIt.effect(
    'unresolved unnamed unarchive review persists no invented display-name evidence',
    () =>
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
        expect(Predicate.isTagged(result, 'blocked')).toBe(true);
        const blocked = Match.value(result).pipe(
          Match.tag('blocked', ({ value }) => value),
          Match.orElse(() =>
            (() => {
              throw new Error('Expected unarchive to be blocked');
            })(),
          ),
        );
        // SAFETY: The first captured insert is the immutable candidate case.
        const persistedCase = harness
          .insertedValues[0] as typeof duplicateCandidateCases.$inferInsert;
        expect(persistedCase.candidateSnapshot.names).toEqual([]);
        expect(persistedCase.candidateSnapshot.officialIdentifiers).toEqual([]);
        expect(harness.updateSets).toEqual([]);
        expect(blocked.reasonCode).toBe('UNRESOLVED_IDENTITY');
      }),
  );

  testIt.effect('archive acquires the tenant identity lock before any Party row lock', () =>
    Effect.gen(function* verifyIdentityPersistence() {
      const harness = transactionHarness([[]]);
      const result = yield* transitionPartyRecord(
        harness.transaction,
        tenantId,
        partyId,
        4,
        'ARCHIVED',
      );
      expect(Predicate.isTagged(result, 'not_found')).toBe(true);
      assertTenantLockIsFirst(harness);
    }),
  );

  testIt.effect(
    'unarchive restores an unclaimed eligible identifier before activating the Party',
    () =>
      Effect.gen(function* verifyIdentityPersistence() {
        const activeParty = partyRow({ archivedAt: null, revision: 5 });
        const harness = transactionHarness(
          [[partyRow()], [], [{ partyId }], [], [identifierRow()], [{}], []],
          [[activeParty]],
        );

        const result = yield* unarchivePartyRecord(harness.transaction, tenantId, partyId, 4);

        expect(Predicate.isTagged(result, 'found')).toBe(true);
        expect(harness.insertedValues).toEqual([
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
        expect(harness.updateSets.length).toBe(1);
        // SAFETY: Unarchive's only update targets the parties table; the harness captures its exact set value.
        expect(
          Object.fromEntries(
            Object.entries(harness.updateSets[0] as Partial<PartyRecord>).filter(
              ([key]) => key !== 'updatedAt',
            ),
          ),
        ).toEqual({ archivedAt: null, revision: 5 });
      }),
  );

  testIt.effect('unarchive rejects an alias rather than forwarding the write to its survivor', () =>
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
      expect(Predicate.isTagged(error, 'PartyAliasWriteRejected')).toBe(true);
      expect(harness.insertedValues).toEqual([]);
      expect(harness.updateSets).toEqual([]);
    }),
  );

  testIt.effect('unarchive reports ambiguous exact claims without changing archived state', () =>
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
      expect(Predicate.isTagged(result, 'identity_ambiguous')).toBe(true);
      expect(Struct.omit(result, ['_tag'])).toEqual({
        candidatePartyIds: [firstOwnerId, secondOwnerId],
      });
      expect(harness.insertedValues).toEqual([]);
      expect(harness.updateSets).toEqual([]);
    }),
  );

  testIt.effect('unarchive does not promote a PERSON ICO into an exclusive strong claim', () =>
    Effect.gen(function* verifyIdentityPersistence() {
      const currentParty = partyRow({ currentType: 'PERSON' });
      const harness = transactionHarness(
        [[currentParty], [], [{ partyId }], [], [identifierRow()]],
        [[{ ...currentParty, archivedAt: null, revision: 5 }]],
      );

      const result = yield* unarchivePartyRecord(harness.transaction, tenantId, partyId, 4);
      expect(Predicate.isTagged(result, 'found')).toBe(true);
      expect(harness.insertedValues).toEqual([]);
      expect(harness.updateSets.length).toBe(1);
    }),
  );

  testIt.effect(
    'unarchive requires review while a duplicate case involving the Party remains open',
    () =>
      Effect.gen(function* verifyIdentityPersistence() {
        const caseId = '88888888-8888-4888-8888-888888888888';
        const harness = transactionHarness([
          [partyRow()],
          [],
          [{ partyId }],
          [{ candidateCaseId: caseId }],
        ]);
        const result = yield* unarchivePartyRecord(harness.transaction, tenantId, partyId, 4);
        expect(Predicate.isTagged(result, 'review_required')).toBe(true);
        expect(Struct.omit(result, ['_tag'])).toEqual({
          caseIds: [caseId],
          reasonCode: 'OPEN_DUPLICATE_CASE',
        });
        expect(harness.insertedValues).toEqual([]);
        expect(harness.updateSets).toEqual([]);
      }),
  );

  testIt.effect(
    'unarchive requires review for unresolved identity without any eligible strong claim',
    () =>
      Effect.gen(function* verifyIdentityPersistence() {
        const harness = transactionHarness([
          [partyRow({ currentType: 'UNRESOLVED' })],
          [],
          [{ partyId }],
          [],
          [],
        ]);
        const result = yield* unarchivePartyRecord(harness.transaction, tenantId, partyId, 4);
        expect(Predicate.isTagged(result, 'review_required')).toBe(true);
        expect(Struct.omit(result, ['_tag'])).toEqual({
          caseIds: [],
          reasonCode: 'UNRESOLVED_IDENTITY',
        });
        expect(harness.insertedValues).toEqual([]);
        expect(harness.updateSets).toEqual([]);
      }),
  );

  testIt.effect(
    'reviewed UNRESOLVED Party can unarchive using retained accepted creation evidence',
    () =>
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
        expect(Predicate.isTagged(result, 'found')).toBe(true);
        expect(harness.updateSets.length).toBe(1);
        expect(harness.insertedValues).toEqual([]);
      }),
  );

  testIt.effect('Party type enrichment refuses another owner of a newly eligible identifier', () =>
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
            subjectKey: partySubjectKeyFromString('one-subject'),
          },
        ],
        validFrom: '2026-01-01T00:00:00.000Z',
      });
      expect(Predicate.isTagged(result, 'conflict')).toBe(true);
      expect(harness.insertedValues).toEqual([]);
      expect(harness.updateSets).toEqual([]);
      expect(harness.deletedTargets).toEqual([]);
    }),
  );

  testIt.effect('Party type enrichment atomically claims identifiers that newly qualify', () =>
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
            subjectKey: partySubjectKeyFromString('one-subject'),
          },
        ],
        validFrom: '2026-01-01T00:00:00.000Z',
      });
      expect(Predicate.isTagged(result, 'found')).toBe(true);
      expect(harness.insertedValues[0]).toEqual([
        {
          identifierTypeKey: 'ICO',
          namespace: 'CZ:ICO',
          normalizedValue: '27074358',
          officialIdentifierId,
          partyId,
          tenantId,
        },
      ]);
      expect(harness.updateSets.length).toBe(2);
    }),
  );

  testIt.effect(
    'type correction reconciliation releases an ICO claim no longer eligible for a PERSON',
    () =>
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
        expect(Predicate.isTagged(result, 'available')).toBe(true);
        expect(Struct.omit(result, ['_tag'])).toEqual({ eligibleClaimCount: 0 });
        expect(harness.deletedTargets.length).toBe(1);
        expect(harness.insertedValues).toEqual([]);
        assertTenantLockIsFirst(harness);
      }),
  );

  testIt.effect(
    'identity updates reject a historical end earlier than the assertion being replaced',
    () =>
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
        expect(Predicate.isTagged(result, 'conflict')).toBe(true);
        expect(harness.insertedValues).toEqual([]);
        expect(harness.updateSets).toEqual([]);
        expect(harness.deletedTargets).toEqual([]);
      }),
  );

  testIt.effect('type enrichment rejects unevidenced type before accepting facts or claims', () =>
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
      expect(Predicate.isTagged(error, 'PartyEvidenceInsufficient')).toBe(true);
      expect(harness.insertedValues).toEqual([]);
      expect(harness.updateSets).toEqual([]);
    }),
  );
});
