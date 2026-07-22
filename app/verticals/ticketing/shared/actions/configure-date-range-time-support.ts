import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { dateRangePropertyDefinitionSchema } from '../task-property-definition.ts';

export const configureDateRangeTimeSupportActionKey =
  'ticketing.configureDateRangeTimeSupport' as const;
export const configureDateRangeTimeSupportActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  confirmed: Schema.Boolean,
  expectedAffectedValueCount: Schema.Finite,
  expectedRevision: Schema.Finite,
  propertyDefinitionId: Schema.String,
  timeEnabled: Schema.Boolean,
});
export const configureDateRangeTimeSupportActionHeadersSchema = idempotentActionHeadersSchema;
export const configureDateRangeTimeSupportActionResponseSchema = Schema.Struct({
  affectedValueCount: Schema.Finite,
  definition: dateRangePropertyDefinitionSchema,
});
export const configureDateRangeTimeSupportActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: configureDateRangeTimeSupportActionResponseSchema,
});
export const configureDateRangeTimeSupportActionFailureSchemas = coreSdkOperationFailureSchemas;
export const configureDateRangeTimeSupportActionFailureSchema = coreSdkOperationFailureSchema;
export type ConfigureDateRangeTimeSupportActionPayload =
  typeof configureDateRangeTimeSupportActionPayloadSchema.Type;
export type ConfigureDateRangeTimeSupportActionResponse =
  typeof configureDateRangeTimeSupportActionResponseSchema.Type;
export type ConfigureDateRangeTimeSupportActionOutcome =
  typeof configureDateRangeTimeSupportActionOutcomeSchema.Type;
export type ConfigureDateRangeTimeSupportActionFailure =
  typeof configureDateRangeTimeSupportActionFailureSchema.Type;
export const configureDateRangeTimeSupportActionTitle =
  'Configure Date Range Time Support' as const;
