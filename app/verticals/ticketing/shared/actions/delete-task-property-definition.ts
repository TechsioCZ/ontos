import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';

export const deleteTaskPropertyDefinitionActionKey =
  'ticketing.deleteTaskPropertyDefinition' as const;

export const deleteTaskPropertyDefinitionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  confirmed: Schema.Literal(true),
  expectedImpactCount: Schema.Finite,
  expectedImpactRevision: Schema.optional(Schema.String),
  expectedRevision: Schema.Finite,
  propertyDefinitionId: Schema.String,
});

export const deleteTaskPropertyDefinitionActionHeadersSchema = idempotentActionHeadersSchema;

export const deleteTaskPropertyDefinitionActionResponseSchema = Schema.Struct({
  deletedPropertyDefinitionId: Schema.String,
  impactCount: Schema.Finite,
});

export const deleteTaskPropertyDefinitionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: deleteTaskPropertyDefinitionActionResponseSchema,
});

export const deleteTaskPropertyDefinitionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const deleteTaskPropertyDefinitionActionFailureSchema = coreSdkOperationFailureSchema;

export type DeleteTaskPropertyDefinitionActionPayload =
  typeof deleteTaskPropertyDefinitionActionPayloadSchema.Type;
export type DeleteTaskPropertyDefinitionActionResponse =
  typeof deleteTaskPropertyDefinitionActionResponseSchema.Type;
export type DeleteTaskPropertyDefinitionActionOutcome =
  typeof deleteTaskPropertyDefinitionActionOutcomeSchema.Type;
export type DeleteTaskPropertyDefinitionActionFailure =
  typeof deleteTaskPropertyDefinitionActionFailureSchema.Type;

export const deleteTaskPropertyDefinitionActionTitle = 'Delete Task Property Definition' as const;
