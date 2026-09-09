// Canonical schema-only contract extracted from the generated confirm-duplicate-parties Action.
import { DuplicateCaseResolutionPayloadSchema } from '../domain/matching-contracts.ts';

export const ConfirmDuplicatePartiesPayloadSchema = DuplicateCaseResolutionPayloadSchema;
export type ConfirmDuplicatePartiesPayload = typeof ConfirmDuplicatePartiesPayloadSchema.Type;
export { DuplicateCaseResolutionResultSchema as ConfirmDuplicatePartiesResultSchema } from '../domain/matching-contracts.ts';
