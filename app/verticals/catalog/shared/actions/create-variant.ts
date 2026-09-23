import { Schema } from 'effect';

import { ProductEvidenceReferenceSchema, ProductReasonSchema, ProductVariantSchema } from '../domain/product.ts';
import { VariantCreationClassificationSchema } from '../domain/product-change-classification.ts';
import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';

/** Creation records a real form, never a cartesian combination inferred from allowed values. */
export const CreateVariantPayloadSchema = Schema.Struct({
  classification: VariantCreationClassificationSchema,
  evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
  expectedProductRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  productRef: ProductRefSchema,
  reason: ProductReasonSchema,
  variantRef: VariantRefSchema,
}).check(
  Schema.makeFilter(({ productRef, variantRef }) =>
    productRef.tenantId === variantRef.tenantId ? undefined : 'Product and Variant must share one Tenant',
  ),
);
export type CreateVariantPayload = typeof CreateVariantPayloadSchema.Type;

export const CreateVariantResultSchema = Schema.Struct({
  classification: Schema.optionalKey(VariantCreationClassificationSchema),
  variant: ProductVariantSchema,
});
export type CreateVariantResult = typeof CreateVariantResultSchema.Type;
