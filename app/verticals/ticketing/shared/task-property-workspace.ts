import { Schema } from '@modern-js/plugin-bff/effect-client';
import { taskPropertyDefinitionSchema } from './task-property-definition.ts';

export const checkboxPropertyValueSchema = Schema.Struct({
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
  value: Schema.Boolean,
});

export const taskPropertyWorkspaceSchema = Schema.Struct({
  collectionId: Schema.String,
  effectiveTimeZone: Schema.optional(
    Schema.Struct({
      source: Schema.Literals(['browser_fallback', 'configured', 'system_fallback']),
      timeZone: Schema.String,
    }),
  ),
  propertyDefinitions: Schema.Array(taskPropertyDefinitionSchema),
  tasks: Schema.Array(
    Schema.Struct({
      checkboxValues: Schema.Array(checkboxPropertyValueSchema),
      createdAt: Schema.optional(Schema.String),
      createdBy: Schema.optional(
        Schema.Struct({
          displayName: Schema.String,
          inactive: Schema.Boolean,
          principalId: Schema.String,
        }),
      ),
      taskId: Schema.String,
      taskRevision: Schema.Finite,
      title: Schema.String,
    }),
  ),
});

export const getTaskPropertyWorkspacePayloadSchema = Schema.Struct({
  browserTimeZone: Schema.optional(Schema.String),
  collectionId: Schema.String,
});

export type GetTaskPropertyWorkspacePayload = typeof getTaskPropertyWorkspacePayloadSchema.Type;
export type TaskPropertyWorkspace = typeof taskPropertyWorkspaceSchema.Type;
