import { Schema } from '@modern-js/plugin-bff/effect-client';
import {
  coreSdkOperationFailureSchema,
  coreSdkOperationFailureSchemas,
  idempotentActionHeadersSchema,
} from '../core-sdk-operation.ts';
import { dateRangeValueSchema } from '../date-range-value.ts';
import { dateRangePropertyValueSchema } from '../task-property-workspace.ts';

export const updateDateRangePropertyValueActionKey =
  'ticketing.updateDateRangePropertyValue' as const;
export const updateDateRangePropertyValueActionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  expectedRevision: Schema.Finite,
  propertyDefinitionId: Schema.String,
  taskId: Schema.String,
  value: Schema.NullOr(dateRangeValueSchema),
});
export const updateDateRangePropertyValueActionHeadersSchema = idempotentActionHeadersSchema;
export const updateDateRangePropertyValueActionResponseSchema = Schema.Struct({
  taskRevision: Schema.Finite,
  value: Schema.NullOr(dateRangePropertyValueSchema),
});
export const updateDateRangePropertyValueActionOutcomeSchema = Schema.Struct({
  actionInvocationId: Schema.optional(Schema.String),
  ok: Schema.Literal(true),
  response: updateDateRangePropertyValueActionResponseSchema,
});
export const updateDateRangePropertyValueActionFailureSchemas = coreSdkOperationFailureSchemas;
export const updateDateRangePropertyValueActionFailureSchema = coreSdkOperationFailureSchema;
export type UpdateDateRangePropertyValueActionPayload =
  typeof updateDateRangePropertyValueActionPayloadSchema.Type;
export type UpdateDateRangePropertyValueActionResponse =
  typeof updateDateRangePropertyValueActionResponseSchema.Type;
export type UpdateDateRangePropertyValueActionOutcome =
  typeof updateDateRangePropertyValueActionOutcomeSchema.Type;
export type UpdateDateRangePropertyValueActionFailure =
  typeof updateDateRangePropertyValueActionFailureSchema.Type;
export const updateDateRangePropertyValueActionTitle = 'Update Date Range Property Value' as const;
