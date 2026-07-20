import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { selectPropertyDefinitionSchema } from '../task-property-definition.ts';

export const createSelectPropertyDefinitionActionKey =
  'ticketing.createSelectPropertyDefinition' as const;

export const createSelectPropertyDefinitionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  mandatory: Schema.Boolean,
  name: Schema.String,
});
export const createSelectPropertyDefinitionActionHeadersSchema = idempotentActionHeadersSchema;
export const createSelectPropertyDefinitionActionResponseSchema = Schema.Struct({
  definition: selectPropertyDefinitionSchema,
});
export const createSelectPropertyDefinitionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createSelectPropertyDefinitionActionResponseSchema,
});
export const createSelectPropertyDefinitionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const createSelectPropertyDefinitionActionFailureSchema = coreSdkOperationFailureSchema;
export type CreateSelectPropertyDefinitionActionPayload =
  typeof createSelectPropertyDefinitionActionPayloadSchema.Type;
export type CreateSelectPropertyDefinitionActionResponse =
  typeof createSelectPropertyDefinitionActionResponseSchema.Type;
export type CreateSelectPropertyDefinitionActionOutcome =
  typeof createSelectPropertyDefinitionActionOutcomeSchema.Type;
export type CreateSelectPropertyDefinitionActionFailure =
  typeof createSelectPropertyDefinitionActionFailureSchema.Type;
export const createSelectPropertyDefinitionActionTitle =
  'Create Select Property Definition' as const;
