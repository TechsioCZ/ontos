// Canonical schema-only contract extracted from the generated dismiss-duplicate-candidate Action.
import { DuplicateCaseResolutionPayloadSchema } from '../domain/matching-contracts.ts';

export const DismissDuplicateCandidatePayloadSchema = DuplicateCaseResolutionPayloadSchema;
export type DismissDuplicateCandidatePayload = typeof DismissDuplicateCandidatePayloadSchema.Type;
export { DuplicateCaseResolutionResultSchema as DismissDuplicateCandidateResultSchema } from '../domain/matching-contracts.ts';
