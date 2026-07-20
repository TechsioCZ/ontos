import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { taskPropertyDefinitionSchema } from '../task-property-definition.ts';

export const duplicateTaskPropertyDefinitionActionKey =
  'ticketing.duplicateTaskPropertyDefinition' as const;

export const duplicateTaskPropertyDefinitionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  copyValues: Schema.Boolean,
  expectedRevision: Schema.Finite,
  propertyDefinitionId: Schema.String,
});

export const duplicateTaskPropertyDefinitionActionHeadersSchema = idempotentActionHeadersSchema;

export const duplicateTaskPropertyDefinitionActionResponseSchema = Schema.Struct({
  definition: taskPropertyDefinitionSchema,
});

export const duplicateTaskPropertyDefinitionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: duplicateTaskPropertyDefinitionActionResponseSchema,
});

export const duplicateTaskPropertyDefinitionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const duplicateTaskPropertyDefinitionActionFailureSchema = coreSdkOperationFailureSchema;

export type DuplicateTaskPropertyDefinitionActionPayload =
  typeof duplicateTaskPropertyDefinitionActionPayloadSchema.Type;
export type DuplicateTaskPropertyDefinitionActionResponse =
  typeof duplicateTaskPropertyDefinitionActionResponseSchema.Type;
export type DuplicateTaskPropertyDefinitionActionOutcome =
  typeof duplicateTaskPropertyDefinitionActionOutcomeSchema.Type;
export type DuplicateTaskPropertyDefinitionActionFailure =
  typeof duplicateTaskPropertyDefinitionActionFailureSchema.Type;

export const duplicateTaskPropertyDefinitionActionTitle =
  'Duplicate Task Property Definition' as const;
