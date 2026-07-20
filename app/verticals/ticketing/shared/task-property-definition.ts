import { Schema } from '@modern-js/plugin-bff/effect-client';

export const checkboxPropertyDefinitionSchema = Schema.Struct({
  datatype: Schema.Literal('checkbox'),
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

// This shared contract is the extension point for each supported Task Property datatype.
export const taskPropertyDefinitionSchema = Schema.Union([
  checkboxPropertyDefinitionSchema,
  selectPropertyDefinitionSchema,
]);

export type CheckboxPropertyDefinition = typeof checkboxPropertyDefinitionSchema.Type;
export type SelectOption = typeof selectOptionSchema.Type;
export type SelectOptionOrderMode = typeof selectOptionOrderModeSchema.Type;
export type SelectPropertyDefinition = typeof selectPropertyDefinitionSchema.Type;
export type TaskPropertyDefinition = typeof taskPropertyDefinitionSchema.Type;
