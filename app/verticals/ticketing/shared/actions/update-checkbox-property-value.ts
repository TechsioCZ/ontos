import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { checkboxPropertyValueSchema } from '../task-property-workspace.ts';

export const updateCheckboxPropertyValueActionKey =
  'ticketing.updateCheckboxPropertyValue' as const;

export const updateCheckboxPropertyValueActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
  value: Schema.Boolean,
});

export const updateCheckboxPropertyValueActionHeadersSchema = idempotentActionHeadersSchema;

export const updateCheckboxPropertyValueActionResponseSchema = Schema.Struct({
  taskRevision: Schema.Finite,
  value: checkboxPropertyValueSchema,
});

export const updateCheckboxPropertyValueActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: updateCheckboxPropertyValueActionResponseSchema,
});

export const updateCheckboxPropertyValueActionFailureSchemas = coreSdkOperationFailureSchemas;
export const updateCheckboxPropertyValueActionFailureSchema = coreSdkOperationFailureSchema;

export type UpdateCheckboxPropertyValueActionPayload =
  typeof updateCheckboxPropertyValueActionPayloadSchema.Type;
export type UpdateCheckboxPropertyValueActionResponse =
  typeof updateCheckboxPropertyValueActionResponseSchema.Type;
export type UpdateCheckboxPropertyValueActionOutcome =
  typeof updateCheckboxPropertyValueActionOutcomeSchema.Type;
export type UpdateCheckboxPropertyValueActionFailure =
  typeof updateCheckboxPropertyValueActionFailureSchema.Type;

export const updateCheckboxPropertyValueActionTitle = 'Update Checkbox Property Value' as const;
