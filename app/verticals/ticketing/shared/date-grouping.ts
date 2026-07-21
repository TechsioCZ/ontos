import { Schema } from '@modern-js/plugin-bff/effect-client';

export const groupTaskDateValuesPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  propertyDefinitionId: Schema.String,
});

export const groupTaskDateValuesResponseSchema = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      taskIds: Schema.Array(Schema.String),
      value: Schema.NullOr(Schema.String),
    }),
  ),
});

export type GroupTaskDateValuesPayload = typeof groupTaskDateValuesPayloadSchema.Type;
export type GroupTaskDateValuesResponse = typeof groupTaskDateValuesResponseSchema.Type;
