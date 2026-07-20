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

export type TextQueryOperation = typeof textQueryOperationSchema.Type;
