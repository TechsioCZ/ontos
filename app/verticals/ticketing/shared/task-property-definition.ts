import { Schema } from '@modern-js/plugin-bff/effect-client';

export const checkboxPropertyDefinitionSchema = Schema.Struct({
  datatype: Schema.Literal('checkbox'),
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
  phonePropertyDefinitionSchema,
]);

export type CheckboxPropertyDefinition = typeof checkboxPropertyDefinitionSchema.Type;
export type PhonePropertyDefinition = typeof phonePropertyDefinitionSchema.Type;
export type TaskPropertyDefinition = typeof taskPropertyDefinitionSchema.Type;
