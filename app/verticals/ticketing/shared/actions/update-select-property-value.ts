import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { selectPropertyValueSchema } from '../task-property-workspace.ts';

export const updateSelectPropertyValueActionKey = 'ticketing.updateSelectPropertyValue' as const;
export const updateSelectPropertyValueActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  optionId: Schema.optional(Schema.String),
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
});
export const updateSelectPropertyValueActionHeadersSchema = idempotentActionHeadersSchema;
export const updateSelectPropertyValueActionResponseSchema = Schema.Struct({
  taskRevision: Schema.Finite,
  value: selectPropertyValueSchema,
});
export const updateSelectPropertyValueActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: updateSelectPropertyValueActionResponseSchema,
});
export const updateSelectPropertyValueActionFailureSchemas = coreSdkOperationFailureSchemas;
export const updateSelectPropertyValueActionFailureSchema = coreSdkOperationFailureSchema;
export type UpdateSelectPropertyValueActionPayload =
  typeof updateSelectPropertyValueActionPayloadSchema.Type;
export type UpdateSelectPropertyValueActionResponse =
  typeof updateSelectPropertyValueActionResponseSchema.Type;
export type UpdateSelectPropertyValueActionOutcome =
  typeof updateSelectPropertyValueActionOutcomeSchema.Type;
export type UpdateSelectPropertyValueActionFailure =
  typeof updateSelectPropertyValueActionFailureSchema.Type;
export const updateSelectPropertyValueActionTitle = 'Update Select Property Value' as const;
