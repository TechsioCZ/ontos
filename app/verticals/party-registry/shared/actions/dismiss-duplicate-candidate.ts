// Canonical schema-only contract extracted from the generated dismiss-duplicate-candidate Action.
import {
  DuplicateCaseResolutionPayloadSchema,
  DuplicateCaseResolutionResultSchema,
} from '../domain/matching-contracts.ts';

export const DismissDuplicateCandidatePayloadSchema = DuplicateCaseResolutionPayloadSchema;
export type DismissDuplicateCandidatePayload = typeof DismissDuplicateCandidatePayloadSchema.Type;
export const DismissDuplicateCandidateResultSchema = DuplicateCaseResolutionResultSchema;
export type DismissDuplicateCandidateResult = typeof DismissDuplicateCandidateResultSchema.Type;
