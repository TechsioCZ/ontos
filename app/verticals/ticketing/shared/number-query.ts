import { Schema } from '@modern-js/plugin-bff/effect-client';

export const numberQueryKindSchema = Schema.Literals(['filter', 'group', 'search', 'sort']);
export const numberFilterOperatorSchema = Schema.Literals([
  'equal',
  'not_equal',
  'greater_than',
  'less_than',
  'greater_than_or_equal',
  'less_than_or_equal',
  'is_empty',
  'is_not_empty',
]);

export const queryTaskNumberValuesPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  direction: Schema.optional(Schema.Literals(['ascending', 'descending'])),
  kind: numberQueryKindSchema,
  operator: Schema.optional(numberFilterOperatorSchema),
  propertyDefinitionId: Schema.String,
  search: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
});

export const numberQueryItemSchema = Schema.Struct({
  taskId: Schema.String,
  value: Schema.Union([Schema.String, Schema.Null]),
});

export const queryTaskNumberValuesResponseSchema = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      taskIds: Schema.Array(Schema.String),
      value: Schema.Union([Schema.String, Schema.Null]),
    }),
  ),
  items: Schema.Array(numberQueryItemSchema),
});

export type QueryTaskNumberValuesPayload = typeof queryTaskNumberValuesPayloadSchema.Type;
export type QueryTaskNumberValuesResponse = typeof queryTaskNumberValuesResponseSchema.Type;
