import { Schema } from 'effect';

import { CatalogRevisionNumberSchema } from '../domain/catalog-revision-reference.ts';
import { ProductEvidenceReferenceSchema, ProductReasonSchema, ProductVariantSchema } from '../domain/product.ts';
import { VariantCombinationKeySchema } from '../domain/variant-axes.ts';
import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';

/**
 * Confirms one explicit Variant's complete Current combination. The Variant row is the
 * authority; the Product-specific allowed values only gate it. A stale axis revision is
 * rejected so a concurrent basis change cannot be bypassed.
 */
export const ConfirmVariantCombinationPayloadSchema = Schema.Struct({
  evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
  expectedAxisRevision: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 2_147_483_646, minimum: 0 })),
  expectedVariantRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  productRef: ProductRefSchema,
  reason: ProductReasonSchema,
  variantRef: VariantRefSchema,
}).check(
  Schema.makeFilter(({ productRef, variantRef }) =>
    productRef.tenantId === variantRef.tenantId ? undefined : 'Product and Variant must share one Tenant',
  ),
);
export type ConfirmVariantCombinationPayload = typeof ConfirmVariantCombinationPayloadSchema.Type;

export const ConfirmVariantCombinationResultSchema = Schema.Struct({
  combinationAxisRevision: CatalogRevisionNumberSchema,
  combinationKey: VariantCombinationKeySchema,
  variant: ProductVariantSchema,
});
export type ConfirmVariantCombinationResult = typeof ConfirmVariantCombinationResultSchema.Type;
