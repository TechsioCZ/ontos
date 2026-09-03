import { Schema } from 'effect';
import { PartyRefSchema } from '../resources/party.ts';
import { IsoTimestampSchema } from './identity-contracts.ts';

export const MergeSurvivorCandidateSchema = Schema.Struct({
  authoritativeEvidenceRank: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  blockingAuthoritativeConflict: Schema.Boolean,
  completenessRank: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  createdAt: IsoTimestampSchema,
  lifecycle: Schema.Literals(['ACTIVE', 'ARCHIVED']),
  partyRef: PartyRefSchema,
  referenceStabilityRank: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type MergeSurvivorCandidate = typeof MergeSurvivorCandidateSchema.Type;

export const MERGE_SURVIVOR_SELECTION_POLICY_VERSION = 'party-merge-survivor-selection.v1' as const;

export const MergeSurvivorSelectionReasonSchema = Schema.Literals([
  'AUTHORITATIVE_EVIDENCE',
  'REFERENCE_STABILITY',
  'LIFECYCLE',
  'DATA_COMPLETENESS',
  'CREATION_AGE',
  'STABLE_RESOURCE_IDENTITY',
]);
export type MergeSurvivorSelectionReason = typeof MergeSurvivorSelectionReasonSchema.Type;

export const MergeSelectionEvidenceCriterionSchema = Schema.Union([
  Schema.Literals(['CONFIRMED_DUPLICATE_SET', 'IDENTITY_SAFETY']),
  MergeSurvivorSelectionReasonSchema,
]);
export type MergeSelectionEvidenceCriterion = typeof MergeSelectionEvidenceCriterionSchema.Type;
export const MergeEvaluatedCandidateSnapshotSchema = Schema.Struct({
  candidate: MergeSurvivorCandidateSchema,
  criterionValue: Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
  eligibleBefore: Schema.Boolean,
  retainedAfter: Schema.Boolean,
});
export const MergeSelectionEvidenceStepSchema = Schema.Struct({
  candidatePartyRefs: Schema.Array(PartyRefSchema).check(Schema.isMinLength(2)),
  candidateSnapshots: Schema.Array(MergeEvaluatedCandidateSnapshotSchema).check(
    Schema.isMinLength(2),
  ),
  criterion: MergeSelectionEvidenceCriterionSchema,
  evidenceRefs: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(
    Schema.isMinLength(1),
  ),
  explanation: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  winnerPartyRef: Schema.NullOr(PartyRefSchema),
});
export type MergeSelectionEvidenceStep = typeof MergeSelectionEvidenceStepSchema.Type;

export const ConfirmedDuplicateSetSchema = Schema.Struct({
  confirmedDuplicateDecisionId: Schema.String.check(Schema.isMinLength(1)),
  confirmedPartyRefs: Schema.Array(PartyRefSchema).check(Schema.isMinLength(2)),
  decisionActorPrincipalId: Schema.String.check(Schema.isMinLength(1)),
  evidenceRefs: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(
    Schema.isMinLength(1),
  ),
});
export type ConfirmedDuplicateSet = typeof ConfirmedDuplicateSetSchema.Type;

export interface MergeSurvivorSelectionInput {
  readonly candidates: readonly MergeSurvivorCandidate[];
  readonly confirmation: ConfirmedDuplicateSet | null;
}
