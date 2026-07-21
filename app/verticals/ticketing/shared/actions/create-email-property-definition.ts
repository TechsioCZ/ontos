import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { emailPropertyDefinitionSchema } from '../task-property-definition.ts';

export { emailPropertyDefinitionSchema } from '../task-property-definition.ts';

export const createEmailPropertyDefinitionActionKey =
  'ticketing.createEmailPropertyDefinition' as const;

export const createEmailPropertyDefinitionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  mandatory: Schema.Boolean,
  name: Schema.String,
});

export const createEmailPropertyDefinitionActionHeadersSchema = idempotentActionHeadersSchema;

export const createEmailPropertyDefinitionActionResponseSchema = Schema.Struct({
  definition: emailPropertyDefinitionSchema,
});

export const createEmailPropertyDefinitionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createEmailPropertyDefinitionActionResponseSchema,
});

export const createEmailPropertyDefinitionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const createEmailPropertyDefinitionActionFailureSchema = coreSdkOperationFailureSchema;

export type CreateEmailPropertyDefinitionActionPayload =
  typeof createEmailPropertyDefinitionActionPayloadSchema.Type;
export type CreateEmailPropertyDefinitionActionResponse =
  typeof createEmailPropertyDefinitionActionResponseSchema.Type;
export type CreateEmailPropertyDefinitionActionOutcome =
  typeof createEmailPropertyDefinitionActionOutcomeSchema.Type;
export type CreateEmailPropertyDefinitionActionFailure =
  typeof createEmailPropertyDefinitionActionFailureSchema.Type;

export const createEmailPropertyDefinitionActionTitle = 'Create Email Property Definition' as const;
