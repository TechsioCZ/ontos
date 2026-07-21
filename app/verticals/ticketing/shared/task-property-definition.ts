import { Schema } from '@modern-js/plugin-bff/effect-client';

export const checkboxPropertyDefinitionSchema = Schema.Struct({
  datatype: Schema.Literal('checkbox'),
  hidden: Schema.Boolean,
  mandatory: Schema.Boolean,
  name: Schema.String,
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
});

export const textPropertyDefinitionSchema = Schema.Struct({
  datatype: Schema.Literal('text'),
  hidden: Schema.Boolean,
  mandatory: Schema.Boolean,
  name: Schema.String,
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
});

export const numberPropertyDefinitionSchema = Schema.Struct({
  datatype: Schema.Literal('number'),
  format: Schema.Literals(['number', 'number_with_separators', 'percent']),
  hidden: Schema.Boolean,
  mandatory: Schema.Boolean,
  name: Schema.String,
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
});

// This shared contract is the extension point for each supported Task Property datatype.
export const taskPropertyDefinitionSchema = Schema.Union([
  checkboxPropertyDefinitionSchema,
  numberPropertyDefinitionSchema,
  textPropertyDefinitionSchema,
]);

export type CheckboxPropertyDefinition = typeof checkboxPropertyDefinitionSchema.Type;
export type NumberPropertyDefinition = typeof numberPropertyDefinitionSchema.Type;
export type TextPropertyDefinition = typeof textPropertyDefinitionSchema.Type;
export type TaskPropertyDefinition = typeof taskPropertyDefinitionSchema.Type;
