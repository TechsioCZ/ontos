// Canonical schema-only contract extracted from the generated mark-duplicate-candidate-needs-evidence Action.
import {
  DuplicateCaseResolutionPayloadSchema,
  DuplicateCaseResolutionResultSchema,
} from '../domain/matching-contracts.ts';

export const MarkDuplicateCandidateNeedsEvidencePayloadSchema =
  DuplicateCaseResolutionPayloadSchema;
export type MarkDuplicateCandidateNeedsEvidencePayload =
  typeof MarkDuplicateCandidateNeedsEvidencePayloadSchema.Type;
export const MarkDuplicateCandidateNeedsEvidenceResultSchema = DuplicateCaseResolutionResultSchema;
export type MarkDuplicateCandidateNeedsEvidenceResult =
  typeof MarkDuplicateCandidateNeedsEvidenceResultSchema.Type;
