import { Schema } from '@modern-js/plugin-bff/effect-client';

export const checkboxPropertyDefinitionSchema = Schema.Struct({
  datatype: Schema.Literal('checkbox'),
  hidden: Schema.Boolean,
  mandatory: Schema.Boolean,
  name: Schema.String,
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
});

export const intrinsicPropertyDefinitionSchema = Schema.Struct({
  datatype: Schema.Literals(['created_time', 'created_by']),
  hidden: Schema.Boolean,
  mandatory: Schema.Boolean,
  name: Schema.String,
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
});

export const selectOptionOrderModeSchema = Schema.Literals([
  'manual',
  'alphabetical',
  'reverse_alphabetical',
]);

export const selectOptionSchema = Schema.Struct({
  color: Schema.String,
  manualPosition: Schema.Finite,
  name: Schema.String,
  optionId: Schema.String,
  revision: Schema.Finite,
});

export const selectPropertyDefinitionSchema = Schema.Struct({
  datatype: Schema.Literal('select'),
  hidden: Schema.Boolean,
  mandatory: Schema.Boolean,
  name: Schema.String,
  optionOrderMode: selectOptionOrderModeSchema,
  options: Schema.Array(selectOptionSchema),
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

export const urlPropertyDefinitionSchema = Schema.Struct({
  datatype: Schema.Literal('url'),
  hidden: Schema.Boolean,
  mandatory: Schema.Boolean,
  name: Schema.String,
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
});

export const emailPropertyDefinitionSchema = Schema.Struct({
  datatype: Schema.Literal('email'),
  hidden: Schema.Boolean,
  mandatory: Schema.Boolean,
  name: Schema.String,
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
});

export const phonePropertyDefinitionSchema = Schema.Struct({
  datatype: Schema.Literal('phone'),
  hidden: Schema.Boolean,
  mandatory: Schema.Boolean,
  name: Schema.String,
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
});

// This shared contract is the extension point for each supported Task Property datatype.
export const taskPropertyDefinitionSchema = Schema.Union([
  checkboxPropertyDefinitionSchema,
  emailPropertyDefinitionSchema,
  intrinsicPropertyDefinitionSchema,
  numberPropertyDefinitionSchema,
  phonePropertyDefinitionSchema,
  selectPropertyDefinitionSchema,
  textPropertyDefinitionSchema,
  urlPropertyDefinitionSchema,
]);

export type CheckboxPropertyDefinition = typeof checkboxPropertyDefinitionSchema.Type;
export type EmailPropertyDefinition = typeof emailPropertyDefinitionSchema.Type;
export type IntrinsicPropertyDefinition = typeof intrinsicPropertyDefinitionSchema.Type;
export type NumberPropertyDefinition = typeof numberPropertyDefinitionSchema.Type;
export type PhonePropertyDefinition = typeof phonePropertyDefinitionSchema.Type;
export type SelectOption = typeof selectOptionSchema.Type;
export type SelectOptionOrderMode = typeof selectOptionOrderModeSchema.Type;
export type SelectPropertyDefinition = typeof selectPropertyDefinitionSchema.Type;
export type TextPropertyDefinition = typeof textPropertyDefinitionSchema.Type;
export type UrlPropertyDefinition = typeof urlPropertyDefinitionSchema.Type;
export type TaskPropertyDefinition = typeof taskPropertyDefinitionSchema.Type;
