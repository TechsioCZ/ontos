// Canonical schema-only contract extracted from the generated confirm-duplicate-parties Action.
import {
  DuplicateCaseResolutionPayloadSchema,
  DuplicateCaseResolutionResultSchema,
} from '../domain/matching-contracts.ts';

export const ConfirmDuplicatePartiesPayloadSchema = DuplicateCaseResolutionPayloadSchema;
export type ConfirmDuplicatePartiesPayload = typeof ConfirmDuplicatePartiesPayloadSchema.Type;
export const ConfirmDuplicatePartiesResultSchema = DuplicateCaseResolutionResultSchema;
export type ConfirmDuplicatePartiesResult = typeof ConfirmDuplicatePartiesResultSchema.Type;
