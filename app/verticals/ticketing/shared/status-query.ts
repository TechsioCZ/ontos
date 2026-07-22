import { Schema } from '@modern-js/plugin-bff/effect-client';

export const statusQueryOperationSchema = Schema.Union([
  Schema.Struct({
    query: Schema.String,
    type: Schema.Literal('search'),
  }),
  Schema.Struct({
    type: Schema.Literal('group'),
  }),
]);

export type StatusQueryOperation = typeof statusQueryOperationSchema.Type;
