// Canonical schema-only contract extracted from the generated resolve-duplicate-candidate-create Action.
import {
  DuplicateCaseResolutionPayloadSchema,
  DuplicateCaseResolutionResultSchema,
} from '../domain/matching-contracts.ts';

export const ResolveDuplicateCandidateCreatePayloadSchema = DuplicateCaseResolutionPayloadSchema;
export type ResolveDuplicateCandidateCreatePayload =
  typeof ResolveDuplicateCandidateCreatePayloadSchema.Type;
export const ResolveDuplicateCandidateCreateResultSchema = DuplicateCaseResolutionResultSchema;
export type ResolveDuplicateCandidateCreateResult =
  typeof ResolveDuplicateCandidateCreateResultSchema.Type;
