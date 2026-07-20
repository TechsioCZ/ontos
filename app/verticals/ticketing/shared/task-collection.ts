import { Schema } from '@modern-js/plugin-bff/effect-client';

export const taskPropertyDefinitionSchema = Schema.Struct({
  datatype: Schema.Literal('title'),
  mandatory: Schema.Boolean,
  name: Schema.String,
  propertyDefinitionId: Schema.String,
});

export const taskCollectionRecordSchema = Schema.Struct({
  collectionId: Schema.String,
  createdAt: Schema.String,
  schemaId: Schema.String,
});

export const taskCollectionSchemaRecordSchema = Schema.Struct({
  collectionId: Schema.String,
  propertyDefinitions: Schema.Array(taskPropertyDefinitionSchema),
  schemaId: Schema.String,
});

export const taskRecordSchema = Schema.Struct({
  collectionId: Schema.String,
  createdAt: Schema.String,
  createdByPrincipalId: Schema.String,
  lastEditedAt: Schema.String,
  lastEditedByPrincipalId: Schema.String,
  revision: Schema.Finite,
  taskId: Schema.String,
  title: Schema.String,
});

export const taskCollectionCreationSchema = Schema.Struct({
  collection: taskCollectionRecordSchema,
  schema: taskCollectionSchemaRecordSchema,
});

export const taskCreationSchema = Schema.Struct({
  task: taskRecordSchema,
});

export const taskCollectionAggregateSchema = Schema.Struct({
  collection: taskCollectionRecordSchema,
  schema: taskCollectionSchemaRecordSchema,
  task: taskRecordSchema,
});

export const getTaskCollectionPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
});

export type TaskCollectionAggregate = typeof taskCollectionAggregateSchema.Type;
export type TaskCollectionCreation = typeof taskCollectionCreationSchema.Type;
export type TaskCreation = typeof taskCreationSchema.Type;
export type GetTaskCollectionPayload = typeof getTaskCollectionPayloadSchema.Type;
