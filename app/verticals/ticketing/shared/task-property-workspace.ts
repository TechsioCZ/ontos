import { Schema } from '@modern-js/plugin-bff/effect-client';
import { taskPropertyDefinitionSchema } from './task-property-definition.ts';
import { textPropertyValueSchema } from './text-property.ts';

export const checkboxPropertyValueSchema = Schema.Struct({
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
  value: Schema.Boolean,
});

export const selectPropertyValueSchema = Schema.Struct({
  optionId: Schema.optional(Schema.String),
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
});

export const numberPropertyValueSchema = Schema.Struct({
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
  value: Schema.Union([Schema.String, Schema.Null]),
});

export const urlPropertyValueSchema = Schema.Struct({
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
  value: Schema.NullOr(Schema.String),
});

export const emailPropertyValueSchema = Schema.Struct({
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
      emailValues: Schema.Array(emailPropertyValueSchema),
      numberValues: Schema.optional(Schema.Array(numberPropertyValueSchema)),
      selectValues: Schema.optional(Schema.Array(selectPropertyValueSchema)),
      taskId: Schema.String,
      taskRevision: Schema.Finite,
      textValues: Schema.optional(Schema.Array(textPropertyValueSchema)),
      title: Schema.String,
      urlValues: Schema.optional(Schema.Array(urlPropertyValueSchema)),
    }),
  ),
});

export const getTaskPropertyWorkspacePayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  locale: Schema.optional(Schema.String),
});

export type GetTaskPropertyWorkspacePayload = typeof getTaskPropertyWorkspacePayloadSchema.Type;
export type CheckboxPropertyValue = typeof checkboxPropertyValueSchema.Type;
export type TaskPropertyWorkspace = typeof taskPropertyWorkspaceSchema.Type;
export type UrlPropertyValue = typeof urlPropertyValueSchema.Type;
