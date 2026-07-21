import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const checkboxPropertyValueSchema: Schema.Struct<{
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
  readonly value: Schema.Boolean;
}>;
export declare const idAssignmentSchema: Schema.Struct<{
  readonly displayValue: Schema.String;
  readonly number: Schema.String;
  readonly propertyDefinitionId: Schema.String;
}>;
export declare const taskPropertyWorkspaceSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
  readonly idGroups: Schema.$Array<
    Schema.Struct<{
      readonly number: Schema.String;
      readonly taskIds: Schema.$Array<Schema.String>;
    }>
  >;
  readonly propertyDefinitions: Schema.$Array<
    Schema.Union<
      readonly [
        Schema.Struct<{
          readonly datatype: Schema.Literal<'checkbox'>;
          readonly hidden: Schema.Boolean;
          readonly mandatory: Schema.Boolean;
          readonly name: Schema.String;
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
        }>,
        Schema.Struct<{
          readonly datatype: Schema.Literal<'id'>;
          readonly hidden: Schema.Boolean;
          readonly mandatory: Schema.Boolean;
          readonly name: Schema.String;
          readonly prefix: Schema.String;
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
        }>,
      ]
    >
  >;
  readonly tasks: Schema.$Array<
    Schema.Struct<{
      readonly checkboxValues: Schema.$Array<
        Schema.Struct<{
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
          readonly value: Schema.Boolean;
        }>
      >;
      readonly idAssignment: Schema.optional<
        Schema.Struct<{
          readonly displayValue: Schema.String;
          readonly number: Schema.String;
          readonly propertyDefinitionId: Schema.String;
        }>
      >;
      readonly taskId: Schema.String;
      readonly taskRevision: Schema.Finite;
      readonly title: Schema.String;
    }>
  >;
}>;
export declare const getTaskPropertyWorkspacePayloadSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
}>;
export type GetTaskPropertyWorkspacePayload = typeof getTaskPropertyWorkspacePayloadSchema.Type;
export type TaskPropertyWorkspace = typeof taskPropertyWorkspaceSchema.Type;
