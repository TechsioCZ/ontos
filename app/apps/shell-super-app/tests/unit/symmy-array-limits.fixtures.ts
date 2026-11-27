import { Schema } from 'effect';

/** The item count bounds an array schema declares. */
export const arrayLimits = (schema: Schema.Top) => {
  const { maxItems, minItems } = Schema.toJsonSchemaDocument(Schema.toType(schema)).schema;
  return { maxItems, minItems };
};
