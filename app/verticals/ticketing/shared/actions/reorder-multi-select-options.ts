import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { multiSelectPropertyDefinitionSchema } from '../task-property-definition.ts';

export const reorderMultiSelectOptionsActionKey = 'ticketing.reorderMultiSelectOptions' as const;
export const reorderMultiSelectOptionsActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedDefinitionRevision: Schema.Finite,
  optionIds: Schema.Array(Schema.String),
  propertyDefinitionId: Schema.String,
});
export const reorderMultiSelectOptionsActionHeadersSchema = idempotentActionHeadersSchema;
export const reorderMultiSelectOptionsActionResponseSchema = Schema.Struct({
  definition: multiSelectPropertyDefinitionSchema,
});
export const reorderMultiSelectOptionsActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: reorderMultiSelectOptionsActionResponseSchema,
});
export const reorderMultiSelectOptionsActionFailureSchemas = coreSdkOperationFailureSchemas;
export const reorderMultiSelectOptionsActionFailureSchema = coreSdkOperationFailureSchema;
export type ReorderMultiSelectOptionsActionPayload =
  typeof reorderMultiSelectOptionsActionPayloadSchema.Type;
export type ReorderMultiSelectOptionsActionResponse =
  typeof reorderMultiSelectOptionsActionResponseSchema.Type;
export type ReorderMultiSelectOptionsActionOutcome =
  typeof reorderMultiSelectOptionsActionOutcomeSchema.Type;
export type ReorderMultiSelectOptionsActionFailure =
  typeof reorderMultiSelectOptionsActionFailureSchema.Type;
export const reorderMultiSelectOptionsActionTitle = 'Reorder Multi-select Options' as const;
