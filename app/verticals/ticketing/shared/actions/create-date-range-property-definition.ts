import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { dateRangePropertyDefinitionSchema } from '../task-property-definition.ts';

export const createDateRangePropertyDefinitionActionKey =
  'ticketing.createDateRangePropertyDefinition' as const;
export const createDateRangePropertyDefinitionActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  mandatory: Schema.Boolean,
  name: Schema.String,
});
export const createDateRangePropertyDefinitionActionHeadersSchema = idempotentActionHeadersSchema;
export const createDateRangePropertyDefinitionActionResponseSchema = Schema.Struct({
  definition: dateRangePropertyDefinitionSchema,
});
export const createDateRangePropertyDefinitionActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: createDateRangePropertyDefinitionActionResponseSchema,
});
export const createDateRangePropertyDefinitionActionFailureSchemas = coreSdkOperationFailureSchemas;
export const createDateRangePropertyDefinitionActionFailureSchema = coreSdkOperationFailureSchema;
export type CreateDateRangePropertyDefinitionActionPayload =
  typeof createDateRangePropertyDefinitionActionPayloadSchema.Type;
export type CreateDateRangePropertyDefinitionActionResponse =
  typeof createDateRangePropertyDefinitionActionResponseSchema.Type;
export type CreateDateRangePropertyDefinitionActionOutcome =
  typeof createDateRangePropertyDefinitionActionOutcomeSchema.Type;
export type CreateDateRangePropertyDefinitionActionFailure =
  typeof createDateRangePropertyDefinitionActionFailureSchema.Type;
export const createDateRangePropertyDefinitionActionTitle =
  'Create Date Range Property Definition' as const;
