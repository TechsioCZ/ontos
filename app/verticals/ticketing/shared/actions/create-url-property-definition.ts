import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { urlPropertyDefinitionSchema } from '../task-property-definition.ts';

export const createUrlPropertyDefinitionActionKey =
  'ticketing.createUrlPropertyDefinition' as const;

export const createUrlPropertyDefinitionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  mandatory: Schema.Boolean,
  name: Schema.String,
});

export const createUrlPropertyDefinitionActionHeadersSchema = idempotentActionHeadersSchema;

export const createUrlPropertyDefinitionActionResponseSchema = Schema.Struct({
  definition: urlPropertyDefinitionSchema,
});

export const createUrlPropertyDefinitionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createUrlPropertyDefinitionActionResponseSchema,
});

export const createUrlPropertyDefinitionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const createUrlPropertyDefinitionActionFailureSchema = coreSdkOperationFailureSchema;

export type CreateUrlPropertyDefinitionActionPayload =
  typeof createUrlPropertyDefinitionActionPayloadSchema.Type;
export type CreateUrlPropertyDefinitionActionResponse =
  typeof createUrlPropertyDefinitionActionResponseSchema.Type;
export type CreateUrlPropertyDefinitionActionOutcome =
  typeof createUrlPropertyDefinitionActionOutcomeSchema.Type;
export type CreateUrlPropertyDefinitionActionFailure =
  typeof createUrlPropertyDefinitionActionFailureSchema.Type;

export const createUrlPropertyDefinitionActionTitle = 'Create URL Property Definition' as const;
