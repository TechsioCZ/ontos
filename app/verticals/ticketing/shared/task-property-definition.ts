import { Schema } from '@modern-js/plugin-bff/effect-client';

export const checkboxPropertyDefinitionSchema = Schema.Struct({
  datatype: Schema.Literal('checkbox'),
  hidden: Schema.Boolean,
  mandatory: Schema.Boolean,
  name: Schema.String,
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
});

export const idPropertyDefinitionSchema = Schema.Struct({
  datatype: Schema.Literal('id'),
  hidden: Schema.Boolean,
  mandatory: Schema.Boolean,
  name: Schema.String,
  prefix: Schema.String,
  propertyDefinitionId: Schema.String,
  revision: Schema.Finite,
});

// This shared contract is the extension point for each supported Task Property datatype.
export const taskPropertyDefinitionSchema = Schema.Union([
  checkboxPropertyDefinitionSchema,
  idPropertyDefinitionSchema,
]);

export type CheckboxPropertyDefinition = typeof checkboxPropertyDefinitionSchema.Type;
export type IdPropertyDefinition = typeof idPropertyDefinitionSchema.Type;
export type TaskPropertyDefinition = typeof taskPropertyDefinitionSchema.Type;
