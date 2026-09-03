import type {
  ConfirmedDuplicateSet,
  MergeSelectionEvidenceCriterion,
  MergeSelectionEvidenceStep,
  MergeSurvivorCandidate,
  MergeSurvivorSelectionInput,
  MergeSurvivorSelectionReason,
} from '../../shared/domain/merge-selection.ts';
import { MERGE_SURVIVOR_SELECTION_POLICY_VERSION } from '../../shared/domain/merge-selection.ts';
import type { PartyRef } from '../../shared/resources/party.ts';

export type CanonicalSurvivorSelection =
  | Readonly<{
      _tag: 'CanonicalSurvivorSelected';
      confirmedDuplicateDecisionId: string;
      decidingCriterion: MergeSurvivorSelectionReason;
      evidenceChain: readonly MergeSelectionEvidenceStep[];
      policyVersion: typeof MERGE_SURVIVOR_SELECTION_POLICY_VERSION;
      survivorPartyRef: PartyRef;
    }>
  | Readonly<{
      _tag: 'SurvivorSelectionBlocked';
      blocker:
        | 'AUTHORITATIVE_IDENTITY_CONFLICT'
        | 'CROSS_TENANT_MERGE_SET'
        | 'DUPLICATE_SET_NOT_CONFIRMED'
        | 'INVALID_MERGE_SET';
      conflictingPartyRefs: readonly PartyRef[];
    }>;

const compareDescending = (left: number, right: number) => right - left;
const compareLifecycle = (left: MergeSurvivorCandidate, right: MergeSurvivorCandidate) =>
  Number(right.lifecycle === 'ACTIVE') - Number(left.lifecycle === 'ACTIVE');
const compareCreatedAt = (left: MergeSurvivorCandidate, right: MergeSurvivorCandidate) =>
  left.createdAt.localeCompare(right.createdAt);
const confirmationHasEvidence = (confirmation: ConfirmedDuplicateSet) =>
  confirmation.confirmedDuplicateDecisionId.trim().length > 0 &&
  confirmation.decisionActorPrincipalId.trim().length > 0 &&
  confirmation.evidenceRefs.length > 0 &&
  confirmation.evidenceRefs.every((reference) => reference.trim().length > 0);

const criterionValue = (
  criterion: MergeSelectionEvidenceCriterion,
  candidate: MergeSurvivorCandidate,
): string | number | boolean =>
  ({
    AUTHORITATIVE_EVIDENCE: candidate.authoritativeEvidenceRank,
    CONFIRMED_DUPLICATE_SET: true,
    CREATION_AGE: candidate.createdAt,
    DATA_COMPLETENESS: candidate.completenessRank,
    IDENTITY_SAFETY: !candidate.blockingAuthoritativeConflict,
    LIFECYCLE: candidate.lifecycle,
    REFERENCE_STABILITY: candidate.referenceStabilityRank,
    STABLE_RESOURCE_IDENTITY: candidate.partyRef.resourceId,
  })[criterion];

const evidenceStep = (
  candidates: readonly MergeSurvivorCandidate[],
  criterion: MergeSelectionEvidenceCriterion,
  evidenceRefs: readonly string[],
  eligible: readonly MergeSurvivorCandidate[],
  retained: readonly MergeSurvivorCandidate[],
  explanation: string,
  winnerPartyRef: PartyRef | null,
): MergeSelectionEvidenceStep =>
  Object.freeze({
    candidatePartyRefs: Object.freeze(candidates.map(({ partyRef }) => partyRef)),
    candidateSnapshots: Object.freeze(
      candidates.map((candidate) =>
        Object.freeze({
          candidate,
          criterionValue: criterionValue(criterion, candidate),
          eligibleBefore: eligible.includes(candidate),
          retainedAfter: retained.includes(candidate),
        }),
      ),
    ),
    criterion,
    evidenceRefs: Object.freeze([...evidenceRefs]),
    explanation,
    winnerPartyRef,
  });

const criteria = [
  {
    compare: (left: MergeSurvivorCandidate, right: MergeSurvivorCandidate) =>
      compareDescending(left.authoritativeEvidenceRank, right.authoritativeEvidenceRank),
    reason: 'AUTHORITATIVE_EVIDENCE',
  },
  {
    compare: (left: MergeSurvivorCandidate, right: MergeSurvivorCandidate) =>
      compareDescending(left.referenceStabilityRank, right.referenceStabilityRank),
    reason: 'REFERENCE_STABILITY',
  },
  { compare: compareLifecycle, reason: 'LIFECYCLE' },
  {
    compare: (left: MergeSurvivorCandidate, right: MergeSurvivorCandidate) =>
      compareDescending(left.completenessRank, right.completenessRank),
    reason: 'DATA_COMPLETENESS',
  },
  { compare: compareCreatedAt, reason: 'CREATION_AGE' },
] as const satisfies readonly Readonly<{
  compare: (left: MergeSurvivorCandidate, right: MergeSurvivorCandidate) => number;
  reason: MergeSurvivorSelectionReason;
}>[];

export const selectCanonicalSurvivor = (
  input: MergeSurvivorSelectionInput,
): CanonicalSurvivorSelection => {
  const { confirmation } = input;
  const candidates = input.candidates
    .map((candidate) =>
      Object.freeze({
        ...candidate,
        partyRef: Object.freeze({ ...candidate.partyRef }),
      }),
    )
    .toSorted((left, right) => left.partyRef.resourceId.localeCompare(right.partyRef.resourceId));
  if (candidates.length < 2) {
    return {
      _tag: 'SurvivorSelectionBlocked',
      blocker: 'INVALID_MERGE_SET',
      conflictingPartyRefs: candidates.map(({ partyRef }) => partyRef),
    };
  }
  const candidateKeys = candidates.map(
    ({ partyRef }) => `${partyRef.tenantId}:${partyRef.resourceId}`,
  );
  if (new Set(candidateKeys).size !== candidates.length) {
    return {
      _tag: 'SurvivorSelectionBlocked',
      blocker: 'INVALID_MERGE_SET',
      conflictingPartyRefs: candidates.map(({ partyRef }) => partyRef),
    };
  }
  const confirmedKeys = confirmation?.confirmedPartyRefs.map(
    ({ tenantId, resourceId }) => `${tenantId}:${resourceId}`,
  );
  if (
    confirmation === null ||
    !confirmationHasEvidence(confirmation) ||
    confirmedKeys?.length !== candidateKeys.length ||
    confirmedKeys.toSorted().some((key, index) => key !== candidateKeys.toSorted()[index])
  ) {
    return {
      _tag: 'SurvivorSelectionBlocked',
      blocker: 'DUPLICATE_SET_NOT_CONFIRMED',
      conflictingPartyRefs: candidates.map(({ partyRef }) => partyRef),
    };
  }
  const tenants = new Set(candidates.map(({ partyRef }) => partyRef.tenantId));
  if (tenants.size !== 1) {
    return {
      _tag: 'SurvivorSelectionBlocked',
      blocker: 'CROSS_TENANT_MERGE_SET',
      conflictingPartyRefs: candidates.map(({ partyRef }) => partyRef),
    };
  }
  const conflicts = candidates.filter(
    ({ blockingAuthoritativeConflict }) => blockingAuthoritativeConflict,
  );
  if (conflicts.length > 0) {
    return {
      _tag: 'SurvivorSelectionBlocked',
      blocker: 'AUTHORITATIVE_IDENTITY_CONFLICT',
      conflictingPartyRefs: conflicts.map(({ partyRef }) => partyRef),
    };
  }

  const ordered = candidates.toSorted((left, right) => {
    for (const { compare } of criteria) {
      const difference = compare(left, right);
      if (difference !== 0) {
        return difference;
      }
    }
    return left.partyRef.resourceId.localeCompare(right.partyRef.resourceId);
  });
  const [survivor, runnerUp] = ordered;
  if (survivor === undefined || runnerUp === undefined) {
    return {
      _tag: 'SurvivorSelectionBlocked',
      blocker: 'INVALID_MERGE_SET',
      conflictingPartyRefs: candidates.map(({ partyRef }) => partyRef),
    };
  }
  const decidingCriterion =
    criteria.find(({ compare }) => compare(survivor, runnerUp) !== 0)?.reason ??
    'STABLE_RESOURCE_IDENTITY';
  const decidingIndex = criteria.findIndex(({ reason }) => reason === decidingCriterion);
  const evidenceChain: MergeSelectionEvidenceStep[] = [
    evidenceStep(
      candidates,
      'CONFIRMED_DUPLICATE_SET',
      confirmation.evidenceRefs,
      candidates,
      candidates,
      `Decision ${confirmation.confirmedDuplicateDecisionId} confirms the same-subject Party set.`,
      null,
    ),
    evidenceStep(
      candidates,
      'IDENTITY_SAFETY',
      confirmation.evidenceRefs,
      candidates,
      candidates,
      'No unresolved authoritative identity conflict blocks survivor selection.',
      null,
    ),
  ];
  const evaluatedCriteria = decidingIndex === -1 ? criteria : criteria.slice(0, decidingIndex + 1);
  let eligible: readonly MergeSurvivorCandidate[] = candidates;
  for (const { reason, compare } of evaluatedCriteria) {
    const retained = eligible.filter((candidate) => compare(candidate, survivor) === 0);
    evidenceChain.push(
      evidenceStep(
        candidates,
        reason,
        confirmation.evidenceRefs,
        eligible,
        retained,
        `${retained.length} of ${eligible.length} eligible candidates remain after ${reason}; ${eligible.length - retained.length} eliminated.`,
        reason === decidingCriterion ? survivor.partyRef : null,
      ),
    );
    eligible = retained;
  }
  if (decidingCriterion === 'STABLE_RESOURCE_IDENTITY') {
    evidenceChain.push(
      evidenceStep(
        candidates,
        decidingCriterion,
        confirmation.evidenceRefs,
        eligible,
        [survivor],
        `${survivor.partyRef.resourceId} wins the final stable identity tie-break among ${eligible.length} eligible candidates.`,
        survivor.partyRef,
      ),
    );
  }

  return {
    _tag: 'CanonicalSurvivorSelected',
    confirmedDuplicateDecisionId: confirmation.confirmedDuplicateDecisionId,
    decidingCriterion,
    evidenceChain: Object.freeze(evidenceChain),
    policyVersion: MERGE_SURVIVOR_SELECTION_POLICY_VERSION,
    survivorPartyRef: survivor.partyRef,
  };
};
