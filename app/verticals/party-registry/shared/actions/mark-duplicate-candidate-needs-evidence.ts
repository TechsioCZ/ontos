// Canonical schema-only contract extracted from the generated mark-duplicate-candidate-needs-evidence Action.
import { DuplicateCaseResolutionPayloadSchema } from '../domain/matching-contracts.ts';

export const MarkDuplicateCandidateNeedsEvidencePayloadSchema =
  DuplicateCaseResolutionPayloadSchema;
export type MarkDuplicateCandidateNeedsEvidencePayload =
  typeof MarkDuplicateCandidateNeedsEvidencePayloadSchema.Type;
export { DuplicateCaseResolutionResultSchema as MarkDuplicateCandidateNeedsEvidenceResultSchema } from '../domain/matching-contracts.ts';
