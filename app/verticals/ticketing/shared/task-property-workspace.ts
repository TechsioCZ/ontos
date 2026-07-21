import { Schema } from '@modern-js/plugin-bff/effect-client';
import { taskPropertyDefinitionSchema } from './task-property-definition.ts';

export const checkboxPropertyValueSchema = Schema.Struct({
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
  value: Schema.Boolean,
});

export const urlPropertyValueSchema = Schema.Struct({
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
  value: Schema.NullOr(Schema.String),
});

export const taskPropertyWorkspaceSchema = Schema.Struct({
  collectionId: Schema.String,
  propertyDefinitions: Schema.Array(taskPropertyDefinitionSchema),
  tasks: Schema.Array(
    Schema.Struct({
      checkboxValues: Schema.Array(checkboxPropertyValueSchema),
      taskId: Schema.String,
      taskRevision: Schema.Finite,
      title: Schema.String,
      urlValues: Schema.optional(Schema.Array(urlPropertyValueSchema)),
    }),
  ),
});

export const getTaskPropertyWorkspacePayloadSchema = Schema.Struct({
  collectionId: Schema.String,
});

export type GetTaskPropertyWorkspacePayload = typeof getTaskPropertyWorkspacePayloadSchema.Type;
export type CheckboxPropertyValue = typeof checkboxPropertyValueSchema.Type;
export type TaskPropertyWorkspace = typeof taskPropertyWorkspaceSchema.Type;
export type UrlPropertyValue = typeof urlPropertyValueSchema.Type;
