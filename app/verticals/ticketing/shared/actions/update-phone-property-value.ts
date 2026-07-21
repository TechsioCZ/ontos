import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { phonePropertyValueSchema } from '../task-property-workspace.ts';

export const updatePhonePropertyValueActionKey = 'ticketing.updatePhonePropertyValue' as const;

export const updatePhonePropertyValueActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
  value: Schema.NullOr(Schema.String),
});

export const updatePhonePropertyValueActionHeadersSchema = idempotentActionHeadersSchema;

export const updatePhonePropertyValueActionResponseSchema = Schema.Struct({
  taskRevision: Schema.Finite,
  value: Schema.NullOr(phonePropertyValueSchema),
});

export const updatePhonePropertyValueActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: updatePhonePropertyValueActionResponseSchema,
});

export const updatePhonePropertyValueActionFailureSchemas = coreSdkOperationFailureSchemas;
export const updatePhonePropertyValueActionFailureSchema = coreSdkOperationFailureSchema;

export type UpdatePhonePropertyValueActionPayload =
  typeof updatePhonePropertyValueActionPayloadSchema.Type;
export type UpdatePhonePropertyValueActionResponse =
  typeof updatePhonePropertyValueActionResponseSchema.Type;
export type UpdatePhonePropertyValueActionOutcome =
  typeof updatePhonePropertyValueActionOutcomeSchema.Type;
export type UpdatePhonePropertyValueActionFailure =
  typeof updatePhonePropertyValueActionFailureSchema.Type;

export const updatePhonePropertyValueActionTitle = 'Update Phone Property Value' as const;
