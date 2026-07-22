import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { multiSelectPropertyDefinitionSchema } from '../task-property-definition.ts';

export const createMultiSelectPropertyDefinitionActionKey =
  'ticketing.createMultiSelectPropertyDefinition' as const;
export const createMultiSelectPropertyDefinitionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  mandatory: Schema.Boolean,
  name: Schema.String,
});
export const createMultiSelectPropertyDefinitionActionHeadersSchema = idempotentActionHeadersSchema;
export const createMultiSelectPropertyDefinitionActionResponseSchema = Schema.Struct({
  definition: multiSelectPropertyDefinitionSchema,
});
export const createMultiSelectPropertyDefinitionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createMultiSelectPropertyDefinitionActionResponseSchema,
});
export const createMultiSelectPropertyDefinitionActionFailureSchemas =
  coreSdkOperationFailureSchemas;
export const createMultiSelectPropertyDefinitionActionFailureSchema = coreSdkOperationFailureSchema;
export type CreateMultiSelectPropertyDefinitionActionPayload =
  typeof createMultiSelectPropertyDefinitionActionPayloadSchema.Type;
export type CreateMultiSelectPropertyDefinitionActionResponse =
  typeof createMultiSelectPropertyDefinitionActionResponseSchema.Type;
export type CreateMultiSelectPropertyDefinitionActionOutcome =
  typeof createMultiSelectPropertyDefinitionActionOutcomeSchema.Type;
export type CreateMultiSelectPropertyDefinitionActionFailure =
  typeof createMultiSelectPropertyDefinitionActionFailureSchema.Type;
export const createMultiSelectPropertyDefinitionActionTitle =
  'Create Multi-select Property Definition' as const;
