import { Schema } from 'effect';

import { AttributeValueSchema } from '../domain/attribute-values.ts';
import { CatalogRevisionNumberSchema } from '../domain/catalog-revision-reference.ts';
import { ProductEvidenceReferenceSchema, ProductReasonSchema } from '../domain/product.ts';
import { AttributeDefinitionRefSchema } from '../resources/attribute-definition.ts';
import { ProductRefSchema } from '../resources/product.ts';

/**
 * An explicit, Product-and-axis-scoped replacement of the permissible Variant values.
 * Allowed values gate an explicit Variant; they never create one, and an empty list is a
 * deliberate "no value is permissible for this axis" snapshot rather than an omission.
 */
export const GovernVariantAllowedValuesPayloadSchema = Schema.Struct({
  attributeDefinitionRef: AttributeDefinitionRefSchema,
  definitionRevision: CatalogRevisionNumberSchema,
  evidenceRefs: Schema.Array(ProductEvidenceReferenceSchema).check(Schema.isMaxLength(64)),
  expectedAllowanceRevision: Schema.Finite.check(
    Schema.isInt(),
    Schema.isBetween({ maximum: 2_147_483_646, minimum: 0 }),
  ),
  expectedAxisRevision: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 2_147_483_646, minimum: 0 })),
  productRef: ProductRefSchema,
  reason: ProductReasonSchema,
  values: Schema.Array(AttributeValueSchema).check(Schema.isMaxLength(1000)),
}).check(
  Schema.makeFilter(({ attributeDefinitionRef, productRef }) =>
    productRef.tenantId === attributeDefinitionRef.tenantId
      ? undefined
      : 'Product and Attribute Definition must share one Tenant',
  ),
);
export type GovernVariantAllowedValuesPayload = typeof GovernVariantAllowedValuesPayloadSchema.Type;

export const GovernVariantAllowedValuesResultSchema = Schema.Struct({
  allowanceRevision: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 2_147_483_647, minimum: 0 })),
  changed: Schema.Boolean,
  productRef: ProductRefSchema,
});
export type GovernVariantAllowedValuesResult = typeof GovernVariantAllowedValuesResultSchema.Type;
