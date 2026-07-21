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

// This shared contract is the extension point for each supported Task Property datatype.
export const taskPropertyDefinitionSchema = Schema.Union([
  checkboxPropertyDefinitionSchema,
  intrinsicPropertyDefinitionSchema,
]);

export type CheckboxPropertyDefinition = typeof checkboxPropertyDefinitionSchema.Type;
export type IntrinsicPropertyDefinition = typeof intrinsicPropertyDefinitionSchema.Type;
export type TaskPropertyDefinition = typeof taskPropertyDefinitionSchema.Type;
