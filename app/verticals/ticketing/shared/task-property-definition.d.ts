import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const checkboxPropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'checkbox'>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const textPropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'text'>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const numberPropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'number'>;
  readonly format: Schema.Literals<readonly ['number', 'number_with_separators', 'percent']>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
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
      readonly datatype: Schema.Literal<'number'>;
      readonly format: Schema.Literals<readonly ['number', 'number_with_separators', 'percent']>;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
    }>,
    Schema.Struct<{
      readonly datatype: Schema.Literal<'text'>;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
    }>,
  ]
>;
export type CheckboxPropertyDefinition = typeof checkboxPropertyDefinitionSchema.Type;
export type NumberPropertyDefinition = typeof numberPropertyDefinitionSchema.Type;
export type TextPropertyDefinition = typeof textPropertyDefinitionSchema.Type;
export type TaskPropertyDefinition = typeof taskPropertyDefinitionSchema.Type;
