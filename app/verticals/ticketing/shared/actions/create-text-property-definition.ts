import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { textPropertyDefinitionSchema } from '../task-property-definition.ts';

export const createTextPropertyDefinitionActionKey =
  'ticketing.createTextPropertyDefinition' as const;

export const createTextPropertyDefinitionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  mandatory: Schema.Boolean,
  name: Schema.String,
});

export const createTextPropertyDefinitionActionHeadersSchema = idempotentActionHeadersSchema;

export const createTextPropertyDefinitionActionResponseSchema = Schema.Struct({
  definition: textPropertyDefinitionSchema,
});

export const createTextPropertyDefinitionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createTextPropertyDefinitionActionResponseSchema,
});

export const createTextPropertyDefinitionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const createTextPropertyDefinitionActionFailureSchema = coreSdkOperationFailureSchema;

export type CreateTextPropertyDefinitionActionPayload =
  typeof createTextPropertyDefinitionActionPayloadSchema.Type;
export type CreateTextPropertyDefinitionActionResponse =
  typeof createTextPropertyDefinitionActionResponseSchema.Type;
export type CreateTextPropertyDefinitionActionOutcome =
  typeof createTextPropertyDefinitionActionOutcomeSchema.Type;
export type CreateTextPropertyDefinitionActionFailure =
  typeof createTextPropertyDefinitionActionFailureSchema.Type;

export const createTextPropertyDefinitionActionTitle = 'Create Text Property Definition' as const;
