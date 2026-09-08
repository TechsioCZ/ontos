import { expect, it } from '@app/effect-rstest';
import { Match, Predicate, Struct, Schema } from 'effect';
import type { PartyRef } from '../../shared/resources/party.ts';
import type {
  MergeSurvivorCandidate,
  MergeSurvivorSelectionInput,
} from '../../shared/domain/merge-selection.ts';
import {
  ConfirmedDuplicateDecisionIdSchema,
  DecisionActorPrincipalIdSchema,
} from '../../shared/domain/merge-selection.ts';
import {
  CanonicalSurvivorSelectionSchema,
  selectCanonicalSurvivor,
} from '../../src/merge/canonical-survivor-selection.ts';
import type { CanonicalSurvivorSelection } from '../../src/merge/canonical-survivor-selection.ts';

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
const confirmedSelection = (
  candidates: readonly ReturnType<typeof candidate>[],
): MergeSurvivorSelectionInput => ({
  candidates,
  confirmation: {
    confirmedDuplicateDecisionId: ConfirmedDuplicateDecisionIdSchema.make('decision-1'),
    confirmedPartyRefs: candidates.map(({ partyRef }) => partyRef),
    decisionActorPrincipalId: DecisionActorPrincipalIdSchema.make('principal-1'),
    evidenceRefs: ['evidence-1'],
  },
});

const expectSelected = (result: CanonicalSurvivorSelection) =>
  Match.value(result).pipe(
    Match.tag('CanonicalSurvivorSelected', (selected) => selected),
    Match.tag('SurvivorSelectionBlocked', ({ blocker }) =>
      ((message: string): never => {
        throw new Error(message);
      })(`Expected a canonical survivor, but selection was blocked by ${blocker}`),
    ),
    Match.exhaustive,
  );

it('blocks survivor selection when authoritative identity truth is unresolved', () => {
  const result = selectCanonicalSurvivor(
    confirmedSelection([
      candidate('party-a'),
      candidate('party-b', { blockingAuthoritativeConflict: true }),
    ]),
  );

  expect(Schema.is(CanonicalSurvivorSelectionSchema.members[1])(result)).toBe(true);
  expect(Struct.omit(result, ['_tag'])).toEqual({
    blocker: 'AUTHORITATIVE_IDENTITY_CONFLICT',
    conflictingPartyRefs: [party('party-b')],
  });
});

it('uses the governed hierarchy before reference count, lifecycle, completeness, or age', () => {
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

  expect(Predicate.isTagged(result, 'CanonicalSurvivorSelected')).toBe(true);
  const selected = expectSelected(result);
  expect(selected.survivorPartyRef).toEqual(party('authoritative'));
  expect(selected.decidingCriterion).toBe('AUTHORITATIVE_EVIDENCE');
  expect(selected.policyVersion).toBe('party-merge-survivor-selection.v1');
  expect(selected.confirmedDuplicateDecisionId).toBe('decision-1');
  expect(selected.evidenceChain.map(({ criterion }) => criterion)).toEqual([
    'CONFIRMED_DUPLICATE_SET',
    'IDENTITY_SAFETY',
    'AUTHORITATIVE_EVIDENCE',
  ]);
});

it('uses reference stability, lifecycle, completeness, age, then resource identity deterministically', () => {
  const referenceWinner = selectCanonicalSurvivor(
    confirmedSelection([
      candidate('a', { referenceStabilityRank: 1 }),
      candidate('b', { referenceStabilityRank: 2 }),
    ]),
  );
  expect(expectSelected(referenceWinner).decidingCriterion).toBe('REFERENCE_STABILITY');

  const deterministic = selectCanonicalSurvivor(
    confirmedSelection([candidate('party-b'), candidate('party-a')]),
  );
  const selected = expectSelected(deterministic);
  expect(selected.survivorPartyRef).toEqual(party('party-a'));
  expect(selected.decidingCriterion).toBe('STABLE_RESOURCE_IDENTITY');
});

it('rejects a cross-tenant merge set before selection', () => {
  const result = selectCanonicalSurvivor(
    confirmedSelection([
      candidate('party-a'),
      candidate('party-b', {
        partyRef: { ...party('party-b'), tenantId: '22222222-2222-4222-8222-222222222222' },
      }),
    ]),
  );

  expect(Schema.is(CanonicalSurvivorSelectionSchema.members[1])(result)).toBe(true);
  expect(Struct.omit(result, ['_tag'])).toEqual({
    blocker: 'CROSS_TENANT_MERGE_SET',
    conflictingPartyRefs: [
      party('party-a'),
      { ...party('party-b'), tenantId: '22222222-2222-4222-8222-222222222222' },
    ],
  });
});

it('rejects selection without an explicit confirmed duplicate decision and matching evidence set', () => {
  const candidates = [candidate('party-a'), candidate('party-b')];
  const unconfirmedSelection = selectCanonicalSurvivor({ candidates, confirmation: null });
  expect(Schema.is(CanonicalSurvivorSelectionSchema.members[1])(unconfirmedSelection)).toBe(true);
  expect(Struct.omit(unconfirmedSelection, ['_tag'])).toEqual({
    blocker: 'DUPLICATE_SET_NOT_CONFIRMED',
    conflictingPartyRefs: [party('party-a'), party('party-b')],
  });
  expect(
    Predicate.isTagged(
      selectCanonicalSurvivor({
        candidates,
        confirmation: {
          confirmedDuplicateDecisionId: ConfirmedDuplicateDecisionIdSchema.make('decision-1'),
          confirmedPartyRefs: [party('party-a')],
          decisionActorPrincipalId: DecisionActorPrincipalIdSchema.make('principal-1'),
          evidenceRefs: ['evidence-1'],
        },
      }),
      'SurvivorSelectionBlocked',
    ),
  ).toBe(true);
});

it('retains immutable evaluated values and explains progressive elimination for three candidates', () => {
  const candidates = [
    candidate('party-a', { authoritativeEvidenceRank: 3, referenceStabilityRank: 2 }),
    candidate('party-b', { authoritativeEvidenceRank: 3, referenceStabilityRank: 1 }),
    candidate('party-c', { authoritativeEvidenceRank: 1, referenceStabilityRank: 100 }),
  ];
  const result = selectCanonicalSurvivor(confirmedSelection(candidates));
  expect(Predicate.isTagged(result, 'CanonicalSurvivorSelected')).toBe(true);
  const selected = expectSelected(result);
  const authority = selected.evidenceChain.find(
    ({ criterion }) => criterion === 'AUTHORITATIVE_EVIDENCE',
  );
  const stability = selected.evidenceChain.find(
    ({ criterion }) => criterion === 'REFERENCE_STABILITY',
  );
  expect(authority).toBeDefined();
  if (authority === undefined) {
    throw new Error('Expected authority');
  }
  expect(stability).toBeDefined();
  if (stability === undefined) {
    throw new Error('Expected stability');
  }
  expect(authority.explanation).toMatch(/2 of 3 eligible candidates remain/u);
  expect(selected.decidingCriterion).toBe('REFERENCE_STABILITY');
  expect(
    authority.candidateSnapshots.map(({ candidate: snapshot, criterionValue, retainedAfter }) => ({
      criterionValue,
      id: snapshot.partyRef.resourceId,
      retainedAfter,
    })),
  ).toEqual([
    { criterionValue: 3, id: 'party-a', retainedAfter: true },
    { criterionValue: 3, id: 'party-b', retainedAfter: true },
    { criterionValue: 1, id: 'party-c', retainedAfter: false },
  ]);
  expect(
    stability.candidateSnapshots.map(({ eligibleBefore, retainedAfter }) => ({
      eligibleBefore,
      retainedAfter,
    })),
  ).toEqual([
    { eligibleBefore: true, retainedAfter: true },
    { eligibleBefore: true, retainedAfter: false },
    { eligibleBefore: false, retainedAfter: false },
  ]);
  const [saved] = authority.candidateSnapshots;
  const [original] = candidates;
  expect(saved).toBeDefined();
  if (saved === undefined) {
    throw new Error('Expected saved');
  }
  expect(original).toBeDefined();
  if (original === undefined) {
    throw new Error('Expected original');
  }
  expect(saved.candidate).toEqual(original);
  Object.assign(original, {
    authoritativeEvidenceRank: 999,
    createdAt: '2030-01-01T00:00:00.000Z',
  });
  expect(saved.candidate.authoritativeEvidenceRank).toBe(3);
  expect(saved.candidate.createdAt).toBe('2024-01-01T00:00:00.000Z');
  expect(Object.isFrozen(saved.candidate)).toBe(true);
  expect(Object.isFrozen(saved.candidate.partyRef)).toBe(true);
  expect(Object.isFrozen(authority.candidateSnapshots)).toBe(true);
});
