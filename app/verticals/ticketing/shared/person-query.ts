import { Schema } from '@modern-js/plugin-bff/effect-client';
import { resolvedPersonSchema } from './task-property-workspace.ts';

export const queryTaskPersonValuesPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  filter: Schema.optional(Schema.Literals(['contains', 'doesNotContain', 'isEmpty', 'isNotEmpty'])),
  group: Schema.optional(Schema.Boolean),
  principalId: Schema.optional(Schema.String),
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
