import { Schema } from '@modern-js/plugin-bff/effect-client';

export const filesMediaQueryOperationSchema = Schema.Union([
  Schema.Struct({ query: Schema.String, type: Schema.Literal('search') }),
  Schema.Struct({
    operator: Schema.Literals(['contains', 'doesNotContain']),
    type: Schema.Literal('filter'),
    value: Schema.String,
  }),
  Schema.Struct({
    operator: Schema.Literals(['isEmpty', 'isNotEmpty']),
    type: Schema.Literal('filter'),
  }),
  Schema.Struct({
    direction: Schema.Literals(['ascending', 'descending']),
    type: Schema.Literal('sort'),
  }),
  Schema.Struct({ type: Schema.Literal('group') }),
]);

export type FilesMediaQueryOperation = typeof filesMediaQueryOperationSchema.Type;
