import { Schema } from '@modern-js/plugin-bff/effect-client';
import { dateRangeValueSchema } from './date-range-value.ts';

export const groupTaskDateRangeValuesPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  propertyDefinitionId: Schema.String,
});

export const groupTaskDateRangeValuesResponseSchema = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      taskIds: Schema.Array(Schema.String),
      value: Schema.NullOr(dateRangeValueSchema),
    }),
  ),
});

export type GroupTaskDateRangeValuesPayload = typeof groupTaskDateRangeValuesPayloadSchema.Type;
export type GroupTaskDateRangeValuesResponse = typeof groupTaskDateRangeValuesResponseSchema.Type;
