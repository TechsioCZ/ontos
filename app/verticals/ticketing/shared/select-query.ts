import { Schema } from '@modern-js/plugin-bff/effect-client';

export const selectQueryOperationSchema = Schema.Union([
  Schema.Struct({
    operator: Schema.Literals(['isEmpty', 'isNotEmpty']),
    type: Schema.Literal('filter'),
  }),
  Schema.Struct({
    operator: Schema.Literals(['is', 'isNot']),
    optionId: Schema.String,
    type: Schema.Literal('filter'),
  }),
]);

export type SelectQueryOperation = typeof selectQueryOperationSchema.Type;
