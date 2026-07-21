import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { numberPropertyDefinitionSchema } from '../task-property-definition.ts';

export const createNumberPropertyDefinitionActionKey =
  'ticketing.createNumberPropertyDefinition' as const;

export const createNumberPropertyDefinitionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  mandatory: Schema.Boolean,
  name: Schema.String,
});

export const createNumberPropertyDefinitionActionHeadersSchema = idempotentActionHeadersSchema;

export const createNumberPropertyDefinitionActionResponseSchema = Schema.Struct({
  definition: numberPropertyDefinitionSchema,
});

export const createNumberPropertyDefinitionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createNumberPropertyDefinitionActionResponseSchema,
});

export const createNumberPropertyDefinitionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const createNumberPropertyDefinitionActionFailureSchema = coreSdkOperationFailureSchema;

export type CreateNumberPropertyDefinitionActionPayload =
  typeof createNumberPropertyDefinitionActionPayloadSchema.Type;
export type CreateNumberPropertyDefinitionActionResponse =
  typeof createNumberPropertyDefinitionActionResponseSchema.Type;
export type CreateNumberPropertyDefinitionActionOutcome =
  typeof createNumberPropertyDefinitionActionOutcomeSchema.Type;
export type CreateNumberPropertyDefinitionActionFailure =
  typeof createNumberPropertyDefinitionActionFailureSchema.Type;

export const createNumberPropertyDefinitionActionTitle =
  'Create Number Property Definition' as const;
