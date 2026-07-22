import { Schema } from '@modern-js/plugin-bff/effect-client';
import { multiSelectQueryOperationSchema } from './multi-select-query.ts';
import { numberQueryOperationSchema } from './number-query.ts';
import { selectQueryOperationSchema } from './select-query.ts';
import { statusQueryOperationSchema } from './status-query.ts';
import { textQueryOperationSchema } from './text-query.ts';
import { filesMediaQueryOperationSchema } from './files-media-query.ts';

export const taskPropertyQuerySchema = Schema.Union([
  Schema.Struct({
    datatype: Schema.Literal('multi_select'),
    operation: multiSelectQueryOperationSchema,
  }),
  Schema.Struct({
    datatype: Schema.Literal('files_media'),
    operation: filesMediaQueryOperationSchema,
  }),
  Schema.Struct({
    datatype: Schema.Literal('number'),
    operation: numberQueryOperationSchema,
  }),
  Schema.Struct({
    datatype: Schema.Literal('select'),
    operation: selectQueryOperationSchema,
  }),
  Schema.Struct({
    datatype: Schema.Literal('status'),
    operation: statusQueryOperationSchema,
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
        identity: Schema.optional(Schema.Union([Schema.Null, Schema.String])),
        taskIds: Schema.Array(Schema.String),
      }),
    ),
  ),
  taskIds: Schema.Array(Schema.String),
});

export type TaskPropertyQuery = typeof taskPropertyQuerySchema.Type;
export type QueryTaskPropertyValuesPayload = typeof queryTaskPropertyValuesPayloadSchema.Type;
export type QueryTaskPropertyValuesResponse = typeof queryTaskPropertyValuesResponseSchema.Type;
