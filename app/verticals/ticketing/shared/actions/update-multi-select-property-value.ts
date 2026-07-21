import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { multiSelectPropertyValueSchema } from '../task-property-workspace.ts';

export const updateMultiSelectPropertyValueActionKey =
  'ticketing.updateMultiSelectPropertyValue' as const;
export const updateMultiSelectPropertyValueActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  optionIds: Schema.Array(Schema.String),
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
});
export const updateMultiSelectPropertyValueActionHeadersSchema = idempotentActionHeadersSchema;
export const updateMultiSelectPropertyValueActionResponseSchema = Schema.Struct({
  taskRevision: Schema.Finite,
  value: multiSelectPropertyValueSchema,
});
export const updateMultiSelectPropertyValueActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: updateMultiSelectPropertyValueActionResponseSchema,
});
export const updateMultiSelectPropertyValueActionFailureSchemas = coreSdkOperationFailureSchemas;
export const updateMultiSelectPropertyValueActionFailureSchema = coreSdkOperationFailureSchema;
export type UpdateMultiSelectPropertyValueActionPayload =
  typeof updateMultiSelectPropertyValueActionPayloadSchema.Type;
export type UpdateMultiSelectPropertyValueActionResponse =
  typeof updateMultiSelectPropertyValueActionResponseSchema.Type;
export type UpdateMultiSelectPropertyValueActionOutcome =
  typeof updateMultiSelectPropertyValueActionOutcomeSchema.Type;
export type UpdateMultiSelectPropertyValueActionFailure =
  typeof updateMultiSelectPropertyValueActionFailureSchema.Type;
export const updateMultiSelectPropertyValueActionTitle =
  'Update Multi-select Property Value' as const;
