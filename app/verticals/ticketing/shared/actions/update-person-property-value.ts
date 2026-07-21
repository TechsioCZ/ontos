import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { personPropertyValueSchema } from '../task-property-workspace.ts';

export const updatePersonPropertyValueActionKey = 'ticketing.updatePersonPropertyValue' as const;

export const updatePersonPropertyValueActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  principalIds: Schema.Array(Schema.String),
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
});

export const updatePersonPropertyValueActionHeadersSchema = idempotentActionHeadersSchema;

export const updatePersonPropertyValueActionResponseSchema = Schema.Struct({
  taskRevision: Schema.Finite,
  value: Schema.Struct({
    principalIds: Schema.Array(Schema.String),
    propertyDefinitionId: personPropertyValueSchema.fields.propertyDefinitionId,
    revision: personPropertyValueSchema.fields.revision,
  }),
});

export const updatePersonPropertyValueActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: updatePersonPropertyValueActionResponseSchema,
});

export const updatePersonPropertyValueActionFailureSchemas = coreSdkOperationFailureSchemas;
export const updatePersonPropertyValueActionFailureSchema = coreSdkOperationFailureSchema;

export type UpdatePersonPropertyValueActionPayload =
  typeof updatePersonPropertyValueActionPayloadSchema.Type;
export type UpdatePersonPropertyValueActionResponse =
  typeof updatePersonPropertyValueActionResponseSchema.Type;
export type UpdatePersonPropertyValueActionOutcome =
  typeof updatePersonPropertyValueActionOutcomeSchema.Type;
export type UpdatePersonPropertyValueActionFailure =
  typeof updatePersonPropertyValueActionFailureSchema.Type;

export const updatePersonPropertyValueActionTitle = 'Update Person Property Value' as const;
