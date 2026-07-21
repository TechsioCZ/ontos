import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { idPropertyDefinitionSchema } from '../task-property-definition.ts';
import type { IdPropertyDefinition } from '../task-property-definition.ts';

export const createIdPropertyDefinitionActionKey = 'ticketing.createIdPropertyDefinition' as const;

export const createIdPropertyDefinitionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  mandatory: Schema.Boolean,
  name: Schema.String,
  prefix: Schema.String,
});

export const createIdPropertyDefinitionActionHeadersSchema = idempotentActionHeadersSchema;

export const createIdPropertyDefinitionActionResponseSchema = Schema.Struct({
  definition: idPropertyDefinitionSchema,
});

export const createIdPropertyDefinitionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createIdPropertyDefinitionActionResponseSchema,
});

export const createIdPropertyDefinitionActionFailureSchema = coreSdkOperationFailureSchema;
export const createIdPropertyDefinitionActionFailureSchemas = coreSdkOperationFailureSchemas;

export type CreateIdPropertyDefinitionActionPayload =
  typeof createIdPropertyDefinitionActionPayloadSchema.Type;
export interface CreateIdPropertyDefinitionActionResponse {
  readonly definition: IdPropertyDefinition;
}
export type CreateIdPropertyDefinitionActionOutcome =
  typeof createIdPropertyDefinitionActionOutcomeSchema.Type;
export type CreateIdPropertyDefinitionActionFailure =
  typeof createIdPropertyDefinitionActionFailureSchema.Type;

export const createIdPropertyDefinitionActionTitle = 'Create ID Property Definition' as const;
