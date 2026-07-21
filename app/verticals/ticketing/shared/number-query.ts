import { Schema } from '@modern-js/plugin-bff/effect-client';

export const numberSearchOperationSchema = Schema.Struct({
  query: Schema.String,
  type: Schema.Literal('search'),
});

export const numberValueFilterOperationSchema = Schema.Struct({
  operator: Schema.Literals([
    'equal',
    'notEqual',
    'greaterThan',
    'lessThan',
    'greaterThanOrEqual',
    'lessThanOrEqual',
  ]),
  type: Schema.Literal('filter'),
  value: Schema.String,
});

export const numberEmptyFilterOperationSchema = Schema.Struct({
  operator: Schema.Literals(['isEmpty', 'isNotEmpty']),
  type: Schema.Literal('filter'),
});

export const numberSortOperationSchema = Schema.Struct({
  direction: Schema.Literals(['ascending', 'descending']),
  type: Schema.Literal('sort'),
});

export const numberGroupOperationSchema = Schema.Struct({
  type: Schema.Literal('group'),
});

export const numberQueryOperationSchema = Schema.Union([
  numberSearchOperationSchema,
  numberValueFilterOperationSchema,
  numberEmptyFilterOperationSchema,
  numberSortOperationSchema,
  numberGroupOperationSchema,
]);

export type NumberQueryOperation = typeof numberQueryOperationSchema.Type;
