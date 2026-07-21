import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { emailPropertyValueSchema } from '../task-property-workspace.ts';

export const updateEmailPropertyValueActionKey = 'ticketing.updateEmailPropertyValue' as const;

export const updateEmailPropertyValueActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
  value: Schema.String,
});

export const updateEmailPropertyValueActionHeadersSchema = idempotentActionHeadersSchema;

export const updateEmailPropertyValueActionResponseSchema = Schema.Struct({
  taskRevision: Schema.Finite,
  value: emailPropertyValueSchema,
});

export const updateEmailPropertyValueActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: updateEmailPropertyValueActionResponseSchema,
});

export const updateEmailPropertyValueActionFailureSchemas = coreSdkOperationFailureSchemas;
export const updateEmailPropertyValueActionFailureSchema = coreSdkOperationFailureSchema;

export type UpdateEmailPropertyValueActionPayload =
  typeof updateEmailPropertyValueActionPayloadSchema.Type;
export type UpdateEmailPropertyValueActionResponse =
  typeof updateEmailPropertyValueActionResponseSchema.Type;
export type UpdateEmailPropertyValueActionOutcome =
  typeof updateEmailPropertyValueActionOutcomeSchema.Type;
export type UpdateEmailPropertyValueActionFailure =
  typeof updateEmailPropertyValueActionFailureSchema.Type;

export const updateEmailPropertyValueActionTitle = 'Update Email Property Value' as const;
