import { Schema } from '@modern-js/plugin-bff/effect-client';
import { numberQueryOperationSchema } from './number-query.ts';
import { textQueryOperationSchema } from './text-query.ts';

export const taskPropertyQuerySchema = Schema.Union([
  Schema.Struct({
    datatype: Schema.Literal('number'),
    operation: numberQueryOperationSchema,
  }),
  Schema.Struct({
    datatype: Schema.Literal('text'),
    operation: textQueryOperationSchema,
  }),
]);

export const queryTaskPropertyValuesPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  propertyDefinitionId: Schema.String,
  query: taskPropertyQuerySchema,
});

export const queryTaskPropertyValuesResponseSchema = Schema.Struct({
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

export type TaskPropertyQuery = typeof taskPropertyQuerySchema.Type;
export type QueryTaskPropertyValuesPayload = typeof queryTaskPropertyValuesPayloadSchema.Type;
export type QueryTaskPropertyValuesResponse = typeof queryTaskPropertyValuesResponseSchema.Type;
