import { Schema } from 'effect';

import { AttributeDefinitionSchema } from '../domain/attribute-values.ts';
import { CatalogRevisionNumberSchema } from '../domain/catalog-revision-reference.ts';
import { ProductReasonSchema } from '../domain/product.ts';
import { AttributeDefinitionRefSchema } from '../resources/attribute-definition.ts';

const evidence = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed(), Schema.isMaxLength(1000));

/** Only rules are proposed. A different meaning or value kind requires a new Definition. */
export const ReviseAttributeDefinitionPayloadSchema = Schema.Struct({
  attributeDefinitionRef: AttributeDefinitionRefSchema,
  evidence,
  expectedRevision: CatalogRevisionNumberSchema,
  proposed: Schema.Struct({
    levels: AttributeDefinitionSchema.fields.levels,
    measurement: AttributeDefinitionSchema.fields.measurement,
    multiplicity: AttributeDefinitionSchema.fields.multiplicity,
    specialStates: AttributeDefinitionSchema.fields.specialStates,
  }),
  reason: ProductReasonSchema,
  sameMeaning: Schema.Literal(true),
});
export type ReviseAttributeDefinitionPayload = typeof ReviseAttributeDefinitionPayloadSchema.Type;

export const ReviseAttributeDefinitionResultSchema = Schema.Struct({
  attributeDefinitionRef: AttributeDefinitionRefSchema,
  changed: Schema.Boolean,
  revision: CatalogRevisionNumberSchema,
});
