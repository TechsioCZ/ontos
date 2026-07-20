import { Schema } from '@modern-js/plugin-bff/effect-client';

export const textSearchOperationSchema = Schema.Struct({
  query: Schema.String,
  type: Schema.Literal('search'),
});

export const textValueFilterOperationSchema = Schema.Struct({
  operator: Schema.Literals([
    'contains',
    'doesNotContain',
    'equals',
    'doesNotEqual',
    'startsWith',
    'endsWith',
  ]),
  type: Schema.Literal('filter'),
  value: Schema.String,
});

export const textEmptyFilterOperationSchema = Schema.Struct({
  operator: Schema.Literals(['isEmpty', 'isNotEmpty']),
  type: Schema.Literal('filter'),
});

export const textSortOperationSchema = Schema.Struct({
  direction: Schema.Literals(['ascending', 'descending']),
  type: Schema.Literal('sort'),
});

export const textGroupOperationSchema = Schema.Struct({
  type: Schema.Literal('group'),
});

export const textQueryOperationSchema = Schema.Union([
  textSearchOperationSchema,
  textValueFilterOperationSchema,
  textEmptyFilterOperationSchema,
  textSortOperationSchema,
  textGroupOperationSchema,
]);

export const queryTaskTextValuesPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  operation: textQueryOperationSchema,
  propertyDefinitionId: Schema.String,
});

export const queryTaskTextValuesResponseSchema = Schema.Struct({
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({
        heading: Schema.Union([Schema.Null, Schema.String]),
        taskIds: Schema.Array(Schema.String),
      }),
    ),
  ),
  taskIds: Schema.Array(Schema.String),
});

export type TextQueryOperation = typeof textQueryOperationSchema.Type;
export type QueryTaskTextValuesPayload = typeof queryTaskTextValuesPayloadSchema.Type;
export type QueryTaskTextValuesResponse = typeof queryTaskTextValuesResponseSchema.Type;
