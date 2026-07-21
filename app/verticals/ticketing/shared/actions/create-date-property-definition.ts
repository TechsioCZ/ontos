import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { datePropertyDefinitionSchema } from '../task-property-definition.ts';

export { datePropertyDefinitionSchema } from '../task-property-definition.ts';

export const createDatePropertyDefinitionActionKey =
  'ticketing.createDatePropertyDefinition' as const;

export const createDatePropertyDefinitionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  mandatory: Schema.Boolean,
  name: Schema.String,
});

export const createDatePropertyDefinitionActionHeadersSchema = idempotentActionHeadersSchema;

export const createDatePropertyDefinitionActionResponseSchema = Schema.Struct({
  definition: datePropertyDefinitionSchema,
});

export const createDatePropertyDefinitionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createDatePropertyDefinitionActionResponseSchema,
});

export const createDatePropertyDefinitionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const createDatePropertyDefinitionActionFailureSchema = coreSdkOperationFailureSchema;

export type CreateDatePropertyDefinitionActionPayload =
  typeof createDatePropertyDefinitionActionPayloadSchema.Type;
export type CreateDatePropertyDefinitionActionResponse =
  typeof createDatePropertyDefinitionActionResponseSchema.Type;
export type CreateDatePropertyDefinitionActionOutcome =
  typeof createDatePropertyDefinitionActionOutcomeSchema.Type;
export type CreateDatePropertyDefinitionActionFailure =
  typeof createDatePropertyDefinitionActionFailureSchema.Type;

export const createDatePropertyDefinitionActionTitle = 'Create Date Property Definition' as const;
