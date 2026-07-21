import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const checkboxPropertyValueSchema: Schema.Struct<{
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
  readonly value: Schema.Boolean;
}>;
export declare const emailPropertyValueSchema: Schema.Struct<{
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
  readonly value: Schema.NullOr<Schema.String>;
}>;
export declare const taskPropertyWorkspaceSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
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
          readonly datatype: Schema.Literal<'email'>;
          readonly hidden: Schema.Boolean;
          readonly mandatory: Schema.Boolean;
          readonly name: Schema.String;
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
      readonly emailValues: Schema.$Array<
        Schema.Struct<{
          readonly propertyDefinitionId: Schema.String;
          readonly revision: Schema.Finite;
          readonly value: Schema.NullOr<Schema.String>;
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
