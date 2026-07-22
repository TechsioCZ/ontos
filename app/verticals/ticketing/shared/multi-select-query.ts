import { Schema } from '@modern-js/plugin-bff/effect-client';

export const multiSelectQueryOperationSchema = Schema.Union([
  Schema.Struct({
    query: Schema.String,
    type: Schema.Literal('search'),
  }),
  Schema.Struct({
    operator: Schema.Literals(['contains', 'doesNotContain']),
    optionId: Schema.String,
    type: Schema.Literal('filter'),
  }),
  Schema.Struct({
    operator: Schema.Literals(['isEmpty', 'isNotEmpty']),
    type: Schema.Literal('filter'),
  }),
]);

export type MultiSelectQueryOperation = typeof multiSelectQueryOperationSchema.Type;
