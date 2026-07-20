import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const checkboxPropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'checkbox'>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const selectOptionOrderModeSchema: Schema.Literals<
  readonly ['manual', 'alphabetical', 'reverse_alphabetical']
>;
export declare const selectOptionSchema: Schema.Struct<{
  readonly color: Schema.String;
  readonly manualPosition: Schema.Finite;
  readonly name: Schema.String;
  readonly optionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const selectPropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'select'>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly optionOrderMode: Schema.Literals<
    readonly ['manual', 'alphabetical', 'reverse_alphabetical']
  >;
  readonly options: Schema.$Array<
    Schema.Struct<{
      readonly color: Schema.String;
      readonly manualPosition: Schema.Finite;
      readonly name: Schema.String;
      readonly optionId: Schema.String;
      readonly revision: Schema.Finite;
    }>
  >;
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
      readonly datatype: Schema.Literal<'select'>;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly optionOrderMode: Schema.Literals<
        readonly ['manual', 'alphabetical', 'reverse_alphabetical']
      >;
      readonly options: Schema.$Array<
        Schema.Struct<{
          readonly color: Schema.String;
          readonly manualPosition: Schema.Finite;
          readonly name: Schema.String;
          readonly optionId: Schema.String;
          readonly revision: Schema.Finite;
        }>
      >;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
    }>,
  ]
>;
export type CheckboxPropertyDefinition = typeof checkboxPropertyDefinitionSchema.Type;
export type SelectOption = typeof selectOptionSchema.Type;
export type SelectOptionOrderMode = typeof selectOptionOrderModeSchema.Type;
export type SelectPropertyDefinition = typeof selectPropertyDefinitionSchema.Type;
export type TaskPropertyDefinition = typeof taskPropertyDefinitionSchema.Type;
