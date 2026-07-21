import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { personPropertyDefinitionSchema } from '../task-property-definition.ts';

export const createPersonPropertyDefinitionActionKey =
  'ticketing.createPersonPropertyDefinition' as const;

export const createPersonPropertyDefinitionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  mandatory: Schema.Boolean,
  name: Schema.String,
});

export const createPersonPropertyDefinitionActionHeadersSchema = idempotentActionHeadersSchema;

export const createPersonPropertyDefinitionActionResponseSchema = Schema.Struct({
  definition: personPropertyDefinitionSchema,
});

export const createPersonPropertyDefinitionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createPersonPropertyDefinitionActionResponseSchema,
});

export const createPersonPropertyDefinitionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const createPersonPropertyDefinitionActionFailureSchema = coreSdkOperationFailureSchema;

export type CreatePersonPropertyDefinitionActionPayload =
  typeof createPersonPropertyDefinitionActionPayloadSchema.Type;
export type CreatePersonPropertyDefinitionActionResponse =
  typeof createPersonPropertyDefinitionActionResponseSchema.Type;
export type CreatePersonPropertyDefinitionActionOutcome =
  typeof createPersonPropertyDefinitionActionOutcomeSchema.Type;
export type CreatePersonPropertyDefinitionActionFailure =
  typeof createPersonPropertyDefinitionActionFailureSchema.Type;

export const createPersonPropertyDefinitionActionTitle =
  'Create Person Property Definition' as const;
