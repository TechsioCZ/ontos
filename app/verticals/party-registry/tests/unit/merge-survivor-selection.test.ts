import assert from 'node:assert/strict';
import test from 'node:test';
import type { PartyRef } from '../../shared/resources/party.ts';
import type { MergeSurvivorCandidate } from '../../shared/domain/merge-selection.ts';
import { selectCanonicalSurvivor } from '../../src/merge/canonical-survivor-selection.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const party = (resourceId: string): PartyRef => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.party',
  tenantId,
});
const candidate = (resourceId: string, overrides: Partial<MergeSurvivorCandidate> = {}) => ({
  authoritativeEvidenceRank: 1,
  blockingAuthoritativeConflict: false,
  completenessRank: 1,
  createdAt: '2024-01-01T00:00:00.000Z',
  lifecycle: 'ACTIVE' as const,
  partyRef: party(resourceId),
  referenceStabilityRank: 1,
  ...overrides,
});
const confirmedSelection = (candidates: readonly ReturnType<typeof candidate>[]) => ({
  candidates,
  confirmation: {
    confirmedDuplicateDecisionId: 'decision-1',
    confirmedPartyRefs: candidates.map(({ partyRef }) => partyRef),
    decisionActorPrincipalId: 'principal-1',
    evidenceRefs: ['evidence-1'],
  },
});

test('blocks survivor selection when authoritative identity truth is unresolved', () => {
  const result = selectCanonicalSurvivor(
    confirmedSelection([
      candidate('party-a'),
      candidate('party-b', { blockingAuthoritativeConflict: true }),
    ]),
  );

  assert.deepEqual(result, {
    _tag: 'SurvivorSelectionBlocked',
    blocker: 'AUTHORITATIVE_IDENTITY_CONFLICT',
    conflictingPartyRefs: [party('party-b')],
  });
});

test('uses the governed hierarchy before reference count, lifecycle, completeness, or age', () => {
  const result = selectCanonicalSurvivor(
    confirmedSelection([
      candidate('well-established', {
        completenessRank: 100,
        createdAt: '2010-01-01T00:00:00.000Z',
        referenceStabilityRank: 100,
      }),
      candidate('authoritative', {
        authoritativeEvidenceRank: 2,
        completenessRank: 0,
        createdAt: '2025-01-01T00:00:00.000Z',
        lifecycle: 'ARCHIVED',
        referenceStabilityRank: 0,
      }),
    ]),
  );

  assert.equal(result._tag, 'CanonicalSurvivorSelected');
  if (result._tag === 'CanonicalSurvivorSelected') {
    assert.deepEqual(result.survivorPartyRef, party('authoritative'));
    assert.equal(result.decidingCriterion, 'AUTHORITATIVE_EVIDENCE');
    assert.equal(result.policyVersion, 'party-merge-survivor-selection.v1');
    assert.equal(result.confirmedDuplicateDecisionId, 'decision-1');
    assert.deepEqual(
      result.evidenceChain.map(({ criterion }) => criterion),
      ['CONFIRMED_DUPLICATE_SET', 'IDENTITY_SAFETY', 'AUTHORITATIVE_EVIDENCE'],
    );
  }
});

test('uses reference stability, lifecycle, completeness, age, then resource identity deterministically', () => {
  const referenceWinner = selectCanonicalSurvivor(
    confirmedSelection([
      candidate('a', { referenceStabilityRank: 1 }),
      candidate('b', { referenceStabilityRank: 2 }),
    ]),
  );
  assert.equal(
    referenceWinner._tag === 'CanonicalSurvivorSelected'
      ? referenceWinner.decidingCriterion
      : undefined,
    'REFERENCE_STABILITY',
  );

  const deterministic = selectCanonicalSurvivor(
    confirmedSelection([candidate('party-b'), candidate('party-a')]),
  );
  assert.deepEqual(
    deterministic._tag === 'CanonicalSurvivorSelected' ? deterministic.survivorPartyRef : undefined,
    party('party-a'),
  );
  assert.equal(
    deterministic._tag === 'CanonicalSurvivorSelected'
      ? deterministic.decidingCriterion
      : undefined,
    'STABLE_RESOURCE_IDENTITY',
  );
});

test('rejects a cross-tenant merge set before selection', () => {
  const result = selectCanonicalSurvivor(
    confirmedSelection([
      candidate('party-a'),
      candidate('party-b', {
        partyRef: { ...party('party-b'), tenantId: '22222222-2222-4222-8222-222222222222' },
      }),
    ]),
  );

  assert.deepEqual(result, {
    _tag: 'SurvivorSelectionBlocked',
    blocker: 'CROSS_TENANT_MERGE_SET',
    conflictingPartyRefs: [
      party('party-a'),
      { ...party('party-b'), tenantId: '22222222-2222-4222-8222-222222222222' },
    ],
  });
});

test('rejects selection without an explicit confirmed duplicate decision and matching evidence set', () => {
  const candidates = [candidate('party-a'), candidate('party-b')];
  assert.deepEqual(selectCanonicalSurvivor({ candidates, confirmation: null }), {
    _tag: 'SurvivorSelectionBlocked',
    blocker: 'DUPLICATE_SET_NOT_CONFIRMED',
    conflictingPartyRefs: [party('party-a'), party('party-b')],
  });
  assert.equal(
    selectCanonicalSurvivor({
      candidates,
      confirmation: {
        confirmedDuplicateDecisionId: 'decision-1',
        confirmedPartyRefs: [party('party-a')],
        decisionActorPrincipalId: 'principal-1',
        evidenceRefs: ['evidence-1'],
      },
    })._tag,
    'SurvivorSelectionBlocked',
  );
});

test('retains immutable evaluated values and explains progressive elimination for three candidates', () => {
  const candidates = [
    candidate('party-a', { authoritativeEvidenceRank: 3, referenceStabilityRank: 2 }),
    candidate('party-b', { authoritativeEvidenceRank: 3, referenceStabilityRank: 1 }),
    candidate('party-c', { authoritativeEvidenceRank: 1, referenceStabilityRank: 100 }),
  ];
  const result = selectCanonicalSurvivor(confirmedSelection(candidates));
  assert.equal(result._tag, 'CanonicalSurvivorSelected');
  if (result._tag !== 'CanonicalSurvivorSelected') {
    return;
  }
  const authority = result.evidenceChain.find(
    ({ criterion }) => criterion === 'AUTHORITATIVE_EVIDENCE',
  );
  const stability = result.evidenceChain.find(
    ({ criterion }) => criterion === 'REFERENCE_STABILITY',
  );
  assert.ok(authority);
  assert.ok(stability);
  assert.match(authority.explanation, /2 of 3 eligible candidates remain/u);
  assert.equal(result.decidingCriterion, 'REFERENCE_STABILITY');
  assert.deepEqual(
    authority.candidateSnapshots.map(({ candidate: snapshot, criterionValue, retainedAfter }) => ({
      criterionValue,
      id: snapshot.partyRef.resourceId,
      retainedAfter,
    })),
    [
      { criterionValue: 3, id: 'party-a', retainedAfter: true },
      { criterionValue: 3, id: 'party-b', retainedAfter: true },
      { criterionValue: 1, id: 'party-c', retainedAfter: false },
    ],
  );
  assert.deepEqual(
    stability.candidateSnapshots.map(({ eligibleBefore, retainedAfter }) => ({
      eligibleBefore,
      retainedAfter,
    })),
    [
      { eligibleBefore: true, retainedAfter: true },
      { eligibleBefore: true, retainedAfter: false },
      { eligibleBefore: false, retainedAfter: false },
    ],
  );
  const [saved] = authority.candidateSnapshots;
  const [original] = candidates;
  assert.ok(saved);
  assert.ok(original);
  assert.deepEqual(saved.candidate, original);
  Object.assign(original, {
    authoritativeEvidenceRank: 999,
    createdAt: '2030-01-01T00:00:00.000Z',
  });
  assert.equal(saved.candidate.authoritativeEvidenceRank, 3);
  assert.equal(saved.candidate.createdAt, '2024-01-01T00:00:00.000Z');
  assert.ok(Object.isFrozen(saved.candidate));
  assert.ok(Object.isFrozen(saved.candidate.partyRef));
  assert.ok(Object.isFrozen(authority.candidateSnapshots));
});
