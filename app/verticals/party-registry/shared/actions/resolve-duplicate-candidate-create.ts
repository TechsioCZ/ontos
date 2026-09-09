// Canonical schema-only contract extracted from the generated resolve-duplicate-candidate-create Action.
import { DuplicateCaseResolutionPayloadSchema } from '../domain/matching-contracts.ts';

export const ResolveDuplicateCandidateCreatePayloadSchema = DuplicateCaseResolutionPayloadSchema;
export type ResolveDuplicateCandidateCreatePayload = typeof ResolveDuplicateCandidateCreatePayloadSchema.Type;
export { DuplicateCaseResolutionResultSchema as ResolveDuplicateCandidateCreateResultSchema } from '../domain/matching-contracts.ts';
