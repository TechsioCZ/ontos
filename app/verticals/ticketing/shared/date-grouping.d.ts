import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const groupTaskDateValuesPayloadSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
  readonly propertyDefinitionId: Schema.String;
}>;
export declare const groupTaskDateValuesResponseSchema: Schema.Struct<{
  readonly groups: Schema.$Array<
    Schema.Struct<{
      readonly taskIds: Schema.$Array<Schema.String>;
      readonly value: Schema.NullOr<Schema.String>;
    }>
  >;
}>;
export type GroupTaskDateValuesPayload = typeof groupTaskDateValuesPayloadSchema.Type;
export type GroupTaskDateValuesResponse = typeof groupTaskDateValuesResponseSchema.Type;
