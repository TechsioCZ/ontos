import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { datePropertyValueSchema } from '../task-property-workspace.ts';

export const updateDatePropertyValueActionKey = 'ticketing.updateDatePropertyValue' as const;

export const updateDatePropertyValueActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
  value: Schema.NullOr(Schema.String),
});

export const updateDatePropertyValueActionHeadersSchema = idempotentActionHeadersSchema;

export const updateDatePropertyValueActionResponseSchema = Schema.Struct({
  taskRevision: Schema.Finite,
  value: Schema.NullOr(datePropertyValueSchema),
});

export const updateDatePropertyValueActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: updateDatePropertyValueActionResponseSchema,
});

export const updateDatePropertyValueActionFailureSchemas = coreSdkOperationFailureSchemas;
export const updateDatePropertyValueActionFailureSchema = coreSdkOperationFailureSchema;

export type UpdateDatePropertyValueActionPayload =
  typeof updateDatePropertyValueActionPayloadSchema.Type;
export type UpdateDatePropertyValueActionResponse =
  typeof updateDatePropertyValueActionResponseSchema.Type;
export type UpdateDatePropertyValueActionOutcome =
  typeof updateDatePropertyValueActionOutcomeSchema.Type;
export type UpdateDatePropertyValueActionFailure =
  typeof updateDatePropertyValueActionFailureSchema.Type;

export const updateDatePropertyValueActionTitle = 'Update Date Property Value' as const;
