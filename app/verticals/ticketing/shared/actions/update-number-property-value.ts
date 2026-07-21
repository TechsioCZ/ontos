import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { numberPropertyValueSchema } from '../task-property-workspace.ts';

export const updateNumberPropertyValueActionKey = 'ticketing.updateNumberPropertyValue' as const;

export const updateNumberPropertyValueActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
  value: Schema.Union([Schema.String, Schema.Null]),
});

export const updateNumberPropertyValueActionHeadersSchema = idempotentActionHeadersSchema;

export const updateNumberPropertyValueActionResponseSchema = Schema.Struct({
  taskRevision: Schema.Finite,
  value: numberPropertyValueSchema,
});

export const updateNumberPropertyValueActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: updateNumberPropertyValueActionResponseSchema,
});

export const updateNumberPropertyValueActionFailureSchemas = coreSdkOperationFailureSchemas;
export const updateNumberPropertyValueActionFailureSchema = coreSdkOperationFailureSchema;

export type UpdateNumberPropertyValueActionPayload =
  typeof updateNumberPropertyValueActionPayloadSchema.Type;
export type UpdateNumberPropertyValueActionResponse =
  typeof updateNumberPropertyValueActionResponseSchema.Type;
export type UpdateNumberPropertyValueActionOutcome =
  typeof updateNumberPropertyValueActionOutcomeSchema.Type;
export type UpdateNumberPropertyValueActionFailure =
  typeof updateNumberPropertyValueActionFailureSchema.Type;

export const updateNumberPropertyValueActionTitle = 'Update Number Property Value' as const;
