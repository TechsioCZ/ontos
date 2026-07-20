import { Schema } from '@modern-js/plugin-bff/effect-client';

export const filterTaskCheckboxValuesPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  propertyDefinitionId: Schema.String,
  value: Schema.Boolean,
});

export const filterTaskCheckboxValuesResponseSchema = Schema.Struct({
  taskIds: Schema.Array(Schema.String),
});

export type FilterTaskCheckboxValuesPayload = typeof filterTaskCheckboxValuesPayloadSchema.Type;
export type FilterTaskCheckboxValuesResponse = typeof filterTaskCheckboxValuesResponseSchema.Type;
