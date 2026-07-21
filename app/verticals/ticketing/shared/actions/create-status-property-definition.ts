import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { statusPropertyDefinitionSchema } from '../task-property-definition.ts';

export const createStatusPropertyDefinitionActionKey =
  'ticketing.createStatusPropertyDefinition' as const;

export const createStatusPropertyDefinitionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  initialColors: Schema.Struct({
    complete: Schema.String,
    inProgress: Schema.String,
    todo: Schema.String,
  }),
  mandatory: Schema.Boolean,
  name: Schema.String,
});
export const createStatusPropertyDefinitionActionHeadersSchema = idempotentActionHeadersSchema;
export const createStatusPropertyDefinitionActionResponseSchema = Schema.Struct({
  definition: statusPropertyDefinitionSchema,
});
export const createStatusPropertyDefinitionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createStatusPropertyDefinitionActionResponseSchema,
});
export const createStatusPropertyDefinitionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const createStatusPropertyDefinitionActionFailureSchema = coreSdkOperationFailureSchema;
export type CreateStatusPropertyDefinitionActionPayload =
  typeof createStatusPropertyDefinitionActionPayloadSchema.Type;
export type CreateStatusPropertyDefinitionActionResponse =
  typeof createStatusPropertyDefinitionActionResponseSchema.Type;
export type CreateStatusPropertyDefinitionActionOutcome =
  typeof createStatusPropertyDefinitionActionOutcomeSchema.Type;
export type CreateStatusPropertyDefinitionActionFailure =
  typeof createStatusPropertyDefinitionActionFailureSchema.Type;
export const createStatusPropertyDefinitionActionTitle =
  'Create Status Property Definition' as const;
