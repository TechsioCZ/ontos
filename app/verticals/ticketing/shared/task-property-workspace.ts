import { Schema } from '@modern-js/plugin-bff/effect-client';
import { taskPropertyDefinitionSchema } from './task-property-definition.ts';
import { filesMediaItemSchema } from './actions/upload-files-media-item.ts';
import { textPropertyValueSchema } from './text-property.ts';
import { dateRangeValueSchema } from './date-range-value.ts';

export const checkboxPropertyValueSchema = Schema.Struct({
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
  value: Schema.Boolean,
});

export const datePropertyValueSchema = Schema.Struct({
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
  value: Schema.NullOr(Schema.String),
});

export const dateRangePropertyValueSchema = Schema.Struct({
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
  value: Schema.NullOr(dateRangeValueSchema),
});

export const idAssignmentSchema = Schema.Struct({
  displayValue: Schema.String,
  number: Schema.String,
  propertyDefinitionId: Schema.String,
});

export const selectPropertyValueSchema = Schema.Struct({
  optionId: Schema.optional(Schema.String),
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
});

export const statusPropertyValueSchema = Schema.Struct({
  optionId: Schema.optional(Schema.String),
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
});

export const multiSelectPropertyValueSchema = Schema.Struct({
  optionIds: Schema.Array(Schema.String),
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
  updatedAt: Schema.String,
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

export const phonePropertyValueSchema = Schema.Struct({
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
  value: Schema.String,
});

export const resolvedPersonSchema = Schema.Struct({
  displayName: Schema.String,
  eligible: Schema.Boolean,
  principalId: Schema.String,
  status: Schema.Literals(['active', 'archived', 'disabled', 'departed']),
});

export const personPropertyValueSchema = Schema.Struct({
  people: Schema.Array(resolvedPersonSchema),
  principalIds: Schema.Array(Schema.String),
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
});

export const taskPropertyWorkspaceSchema = Schema.Struct({
  collectionId: Schema.String,
  effectiveTimeZone: Schema.optional(
    Schema.Struct({
      source: Schema.Literals(['browser_fallback', 'configured', 'system_fallback']),
      timeZone: Schema.String,
    }),
  ),
  idGroups: Schema.Array(
    Schema.Struct({
      number: Schema.String,
      taskIds: Schema.Array(Schema.String),
    }),
  ),
  propertyDefinitions: Schema.Array(taskPropertyDefinitionSchema),
  tasks: Schema.Array(
    Schema.Struct({
      canvas: Schema.Json,
      checkboxValues: Schema.Array(checkboxPropertyValueSchema),
      createdAt: Schema.optional(Schema.String),
      createdBy: Schema.optional(
        Schema.Struct({
          displayName: Schema.String,
          inactive: Schema.Boolean,
          principalId: Schema.String,
        }),
      ),
      dateRangeValues: Schema.Array(dateRangePropertyValueSchema),
      dateValues: Schema.Array(datePropertyValueSchema),
      emailValues: Schema.Array(emailPropertyValueSchema),
      filesMediaItems: Schema.Array(filesMediaItemSchema),
      idAssignment: Schema.optional(idAssignmentSchema),
      lastEditedAt: Schema.optional(Schema.String),
      lastEditedBy: Schema.optional(
        Schema.Struct({
          displayName: Schema.String,
          inactive: Schema.Boolean,
          principalId: Schema.String,
        }),
      ),
      multiSelectValues: Schema.optional(Schema.Array(multiSelectPropertyValueSchema)),
      numberValues: Schema.optional(Schema.Array(numberPropertyValueSchema)),
      personValues: Schema.optional(Schema.Array(personPropertyValueSchema)),
      phoneValues: Schema.Array(phonePropertyValueSchema),
      selectValues: Schema.optional(Schema.Array(selectPropertyValueSchema)),
      statusValues: Schema.Array(statusPropertyValueSchema),
      taskId: Schema.String,
      taskRevision: Schema.Finite,
      textValues: Schema.optional(Schema.Array(textPropertyValueSchema)),
      title: Schema.String,
      urlValues: Schema.optional(Schema.Array(urlPropertyValueSchema)),
    }),
  ),
});

export const getTaskPropertyWorkspacePayloadSchema = Schema.Struct({
  browserTimeZone: Schema.optional(Schema.String),
  collectionId: Schema.String,
  locale: Schema.optional(Schema.String),
});

export type GetTaskPropertyWorkspacePayload = typeof getTaskPropertyWorkspacePayloadSchema.Type;
export type CheckboxPropertyValue = typeof checkboxPropertyValueSchema.Type;
export type IdAssignment = typeof idAssignmentSchema.Type;
export type PhonePropertyValue = typeof phonePropertyValueSchema.Type;
export type TaskPropertyWorkspace = typeof taskPropertyWorkspaceSchema.Type;
export type UrlPropertyValue = typeof urlPropertyValueSchema.Type;
