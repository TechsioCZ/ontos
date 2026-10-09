import { Schema } from 'effect';

import {
  ProductDescriptionSchema,
  ProductEvidenceReferenceSchema,
  ProductNameSchema,
  ProductReasonSchema,
  ProductSchema,
  ProductRevisionSchema,
} from '../domain/product.ts';
import {
  CosmeticProductCorrectionSchema,
  ProductChangeClassificationSchema,
} from '../domain/product-change-classification.ts';
import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';

export const CorrectProductPayloadSchema = Schema.Struct({
  classification: ProductChangeClassificationSchema,
  description: Schema.optionalKey(ProductDescriptionSchema),
  expectedRevision: ProductRevisionSchema,
  name: Schema.optionalKey(ProductNameSchema),
  productRef: ProductRefSchema,
  reason: ProductReasonSchema,
});
export type CorrectProductPayload = typeof CorrectProductPayloadSchema.Type;

/** #479 consumes this handoff and performs final Current Catalog Selection revalidation. */
export const ProductSelectionRevalidationRequiredSchema = Schema.Struct({
  affectedVariantProductRef: Schema.optionalKey(ProductRefSchema),
  affectedVariantRef: Schema.optionalKey(VariantRefSchema),
  evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
  kind: Schema.Literal('REVALIDATION_REQUIRED'),
  productRef: ProductRefSchema,
  reason: ProductReasonSchema,
  sourceRevision: ProductRevisionSchema,
}).check(
  Schema.makeFilter(({ affectedVariantProductRef, affectedVariantRef, productRef }) => {
    if (affectedVariantRef === undefined) {
      return affectedVariantProductRef === undefined ? undefined : 'Variant owner requires an affected Variant';
    }
    return affectedVariantProductRef !== undefined &&
      affectedVariantRef.tenantId === productRef.tenantId &&
      affectedVariantProductRef.tenantId === productRef.tenantId &&
      affectedVariantProductRef.resourceId === productRef.resourceId
      ? undefined
      : 'Revalidation Variant must retain the same Product owner and Tenant';
  }),
);
const ProductSelectionRevalidationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('NOT_REQUIRED') }),
  ProductSelectionRevalidationRequiredSchema,
]);
export type ProductSelectionRevalidation = typeof ProductSelectionRevalidationSchema.Type;

export const CorrectProductResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  classification: CosmeticProductCorrectionSchema,
  product: ProductSchema,
  selectionRevalidation: ProductSelectionRevalidationSchema,
});
export type CorrectProductResult = typeof CorrectProductResultSchema.Type;
