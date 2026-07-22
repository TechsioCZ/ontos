import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { statusPropertyValueSchema } from '../task-property-workspace.ts';

export const updateStatusPropertyValueActionKey = 'ticketing.updateStatusPropertyValue' as const;
export const updateStatusPropertyValueActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  optionId: Schema.optional(Schema.String),
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
});
export const updateStatusPropertyValueActionHeadersSchema = idempotentActionHeadersSchema;
export const updateStatusPropertyValueActionResponseSchema = Schema.Struct({
  taskRevision: Schema.Finite,
  value: statusPropertyValueSchema,
});
export const updateStatusPropertyValueActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: updateStatusPropertyValueActionResponseSchema,
});
export const updateStatusPropertyValueActionFailureSchemas = coreSdkOperationFailureSchemas;
export const updateStatusPropertyValueActionFailureSchema = coreSdkOperationFailureSchema;
export type UpdateStatusPropertyValueActionPayload =
  typeof updateStatusPropertyValueActionPayloadSchema.Type;
export type UpdateStatusPropertyValueActionResponse =
  typeof updateStatusPropertyValueActionResponseSchema.Type;
export type UpdateStatusPropertyValueActionOutcome =
  typeof updateStatusPropertyValueActionOutcomeSchema.Type;
export type UpdateStatusPropertyValueActionFailure =
  typeof updateStatusPropertyValueActionFailureSchema.Type;
export const updateStatusPropertyValueActionTitle = 'Update Status Property Value' as const;
