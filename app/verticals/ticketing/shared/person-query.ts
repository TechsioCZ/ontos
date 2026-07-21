import { Schema } from '@modern-js/plugin-bff/effect-client';
import { resolvedPersonSchema } from './task-property-workspace.ts';

export const taskPersonQueryFilterSchema = Schema.Union([
  Schema.Struct({
    operator: Schema.Literals(['contains', 'doesNotContain']),
    principalId: Schema.String,
  }),
  Schema.Struct({
    operator: Schema.Literals(['isEmpty', 'isNotEmpty']),
  }),
]);

export const queryTaskPersonValuesPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  filter: Schema.optional(taskPersonQueryFilterSchema),
  group: Schema.optional(Schema.Boolean),
  propertyDefinitionId: Schema.String,
  search: Schema.optional(Schema.String),
  sort: Schema.optional(Schema.Literals(['ascending', 'descending'])),
});

export const queryTaskPersonValuesResponseSchema = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      person: Schema.Union([resolvedPersonSchema, Schema.Null]),
      taskIds: Schema.Array(Schema.String),
    }),
  ),
  taskIds: Schema.Array(Schema.String),
});

export type QueryTaskPersonValuesPayload = typeof queryTaskPersonValuesPayloadSchema.Type;
export type QueryTaskPersonValuesResponse = typeof queryTaskPersonValuesResponseSchema.Type;
export type TaskPersonQueryFilter = typeof taskPersonQueryFilterSchema.Type;
