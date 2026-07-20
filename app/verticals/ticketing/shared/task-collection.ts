import { Schema } from '@modern-js/plugin-bff/effect-client';

export const taskPropertyDefinitionSchema = Schema.Struct({
  datatype: Schema.Literal('title'),
  mandatory: Schema.Boolean,
  name: Schema.String,
  propertyDefinitionId: Schema.String,
});

export const taskCollectionAggregateSchema = Schema.Struct({
  collection: Schema.Struct({
    collectionId: Schema.String,
    createdAt: Schema.String,
    schemaId: Schema.String,
  }),
  schema: Schema.Struct({
    collectionId: Schema.String,
    propertyDefinitions: Schema.Array(taskPropertyDefinitionSchema),
    schemaId: Schema.String,
  }),
  task: Schema.Struct({
    collectionId: Schema.String,
    createdAt: Schema.String,
    createdByPrincipalId: Schema.String,
    lastEditedAt: Schema.String,
    lastEditedByPrincipalId: Schema.String,
    revision: Schema.Finite,
    taskId: Schema.String,
    title: Schema.String,
  }),
});

export const getTaskCollectionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
});

export type TaskCollectionAggregate = typeof taskCollectionAggregateSchema.Type;
export type GetTaskCollectionPayload = typeof getTaskCollectionPayloadSchema.Type;
