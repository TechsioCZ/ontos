import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { urlPropertyValueSchema } from '../task-property-workspace.ts';

export const updateUrlPropertyValueActionKey = 'ticketing.updateUrlPropertyValue' as const;

export const updateUrlPropertyValueActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
  value: Schema.String,
});

export const updateUrlPropertyValueActionHeadersSchema = idempotentActionHeadersSchema;

export const updateUrlPropertyValueActionResponseSchema = Schema.Struct({
  taskRevision: Schema.Finite,
  value: urlPropertyValueSchema,
});

export const updateUrlPropertyValueActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: updateUrlPropertyValueActionResponseSchema,
});

export const updateUrlPropertyValueActionFailureSchemas = coreSdkOperationFailureSchemas;
export const updateUrlPropertyValueActionFailureSchema = coreSdkOperationFailureSchema;

export type UpdateUrlPropertyValueActionPayload =
  typeof updateUrlPropertyValueActionPayloadSchema.Type;
export type UpdateUrlPropertyValueActionResponse =
  typeof updateUrlPropertyValueActionResponseSchema.Type;
export type UpdateUrlPropertyValueActionOutcome =
  typeof updateUrlPropertyValueActionOutcomeSchema.Type;
export type UpdateUrlPropertyValueActionFailure =
  typeof updateUrlPropertyValueActionFailureSchema.Type;

export const updateUrlPropertyValueActionTitle = 'Update URL Property Value' as const;
