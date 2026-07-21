import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { nullableTextDocumentSchema, textPropertyValueSchema } from '../text-property.ts';

export const updateTextPropertyValueActionKey = 'ticketing.updateTextPropertyValue' as const;

export const updateTextPropertyValueActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  document: nullableTextDocumentSchema,
  expectedRevision: Schema.Finite,
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
});

export const updateTextPropertyValueActionHeadersSchema = idempotentActionHeadersSchema;

export const updateTextPropertyValueActionResponseSchema = Schema.Struct({
  taskRevision: Schema.Finite,
  value: textPropertyValueSchema,
});

export const updateTextPropertyValueActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: updateTextPropertyValueActionResponseSchema,
});

export const updateTextPropertyValueActionFailureSchemas = coreSdkOperationFailureSchemas;
export const updateTextPropertyValueActionFailureSchema = coreSdkOperationFailureSchema;

export type UpdateTextPropertyValueActionPayload =
  typeof updateTextPropertyValueActionPayloadSchema.Type;
export type UpdateTextPropertyValueActionResponse =
  typeof updateTextPropertyValueActionResponseSchema.Type;
export type UpdateTextPropertyValueActionOutcome =
  typeof updateTextPropertyValueActionOutcomeSchema.Type;
export type UpdateTextPropertyValueActionFailure =
  typeof updateTextPropertyValueActionFailureSchema.Type;

export const updateTextPropertyValueActionTitle = 'Update Text Property Value' as const;
