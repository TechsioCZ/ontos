import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const groupTaskDateRangeValuesPayloadSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
  readonly propertyDefinitionId: Schema.String;
}>;
export declare const groupTaskDateRangeValuesResponseSchema: Schema.Struct<{
  readonly groups: Schema.$Array<
    Schema.Struct<{
      readonly taskIds: Schema.$Array<Schema.String>;
      readonly value: Schema.NullOr<
        Schema.Struct<{
          readonly endDate: Schema.String;
          readonly endTime: Schema.NullOr<Schema.String>;
          readonly startDate: Schema.String;
          readonly startTime: Schema.NullOr<Schema.String>;
        }>
      >;
    }>
  >;
}>;
export type GroupTaskDateRangeValuesPayload = typeof groupTaskDateRangeValuesPayloadSchema.Type;
export type GroupTaskDateRangeValuesResponse = typeof groupTaskDateRangeValuesResponseSchema.Type;
