import { Schema } from '@modern-js/plugin-bff/effect-client';

export const intrinsicTaskPropertyQueryOperationSchema = Schema.Union([
  Schema.TaggedStruct('CreatedBySearch', { value: Schema.String }),
  Schema.TaggedStruct('CreatedByFilter', { principalId: Schema.String }),
  Schema.TaggedStruct('CreatedBySort', {
    direction: Schema.Literals(['ascending', 'descending']),
  }),
  Schema.TaggedStruct('CreatedByGroup', {}),
  Schema.TaggedStruct('CreatedTimeSearch', { value: Schema.String }),
  Schema.TaggedStruct('CreatedTimeFilter', {
    endValue: Schema.optional(Schema.String),
    operator: Schema.Literals([
      'exact',
      'before',
      'after',
      'on_or_before',
      'on_or_after',
      'local_day',
      'local_range',
    ]),
    value: Schema.String,
  }),
  Schema.TaggedStruct('CreatedTimeSort', {
    direction: Schema.Literals(['ascending', 'descending']),
  }),
  Schema.TaggedStruct('CreatedTimeGroup', {}),
]);

export const queryIntrinsicTaskPropertiesPayloadSchema = Schema.Struct({
  browserTimeZone: Schema.optional(Schema.String),
  collectionId: Schema.String,
  operation: intrinsicTaskPropertyQueryOperationSchema,
  propertyDefinitionId: Schema.String,
});

export const intrinsicTaskQueryRowSchema = Schema.Struct({
  createdAt: Schema.String,
  createdBy: Schema.Struct({
    displayName: Schema.String,
    inactive: Schema.Boolean,
    principalId: Schema.String,
  }),
  taskId: Schema.String,
});

export const queryIntrinsicTaskPropertiesResponseSchema = Schema.Struct({
  effectiveTimeZone: Schema.optional(
    Schema.Struct({
      source: Schema.Literals(['browser_fallback', 'configured', 'system_fallback']),
      timeZone: Schema.String,
    }),
  ),
  groups: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      label: Schema.String,
      taskIds: Schema.Array(Schema.String),
    }),
  ),
  tasks: Schema.Array(intrinsicTaskQueryRowSchema),
});

export type IntrinsicTaskPropertyQueryOperation =
  typeof intrinsicTaskPropertyQueryOperationSchema.Type;
export type QueryIntrinsicTaskPropertiesPayload =
  typeof queryIntrinsicTaskPropertiesPayloadSchema.Type;
export type QueryIntrinsicTaskPropertiesResponse =
  typeof queryIntrinsicTaskPropertiesResponseSchema.Type;
