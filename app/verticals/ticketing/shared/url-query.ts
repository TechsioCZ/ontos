import { Schema } from '@modern-js/plugin-bff/effect-client';

export const taskUrlQueryOperationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('search'),
    query: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('filter'),
    operator: Schema.Literals(['contains', 'does_not_contain']),
    query: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('filter'),
    operator: Schema.Literals(['is_empty', 'is_not_empty']),
  }),
  Schema.Struct({
    direction: Schema.Literals(['ascending', 'descending']),
    kind: Schema.Literal('sort'),
  }),
  Schema.Struct({
    kind: Schema.Literal('group'),
  }),
]);

export const queryTaskUrlValuesPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  operation: taskUrlQueryOperationSchema,
  propertyDefinitionId: Schema.String,
});

export const urlValueGroupSchema = Schema.Struct({
  heading: Schema.NullOr(Schema.String),
  taskIds: Schema.Array(Schema.String),
});

export const queryTaskUrlValuesResponseSchema = Schema.Struct({
  groups: Schema.Array(urlValueGroupSchema),
  taskIds: Schema.Array(Schema.String),
});

export type QueryTaskUrlValuesPayload = typeof queryTaskUrlValuesPayloadSchema.Type;
export type QueryTaskUrlValuesResponse = typeof queryTaskUrlValuesResponseSchema.Type;
