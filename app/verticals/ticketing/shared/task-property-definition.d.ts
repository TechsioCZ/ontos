import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const checkboxPropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'checkbox'>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const idPropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'id'>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly prefix: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const taskPropertyDefinitionSchema: Schema.Union<
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
>;
export type CheckboxPropertyDefinition = typeof checkboxPropertyDefinitionSchema.Type;
export type IdPropertyDefinition = typeof idPropertyDefinitionSchema.Type;
export type TaskPropertyDefinition = typeof taskPropertyDefinitionSchema.Type;
