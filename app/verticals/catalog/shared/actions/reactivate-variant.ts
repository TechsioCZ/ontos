import { Schema } from 'effect';

import { ProductEvidenceReferenceSchema, ProductReasonSchema, ProductVariantSchema } from '../domain/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';

export const ReactivateVariantPayloadSchema = Schema.Struct({
  evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
  expectedVariantRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  reason: ProductReasonSchema,
  variantRef: VariantRefSchema,
});
export type ReactivateVariantPayload = typeof ReactivateVariantPayloadSchema.Type;

export const ReactivateVariantResultSchema = Schema.Struct({ variant: ProductVariantSchema });
export type ReactivateVariantResult = typeof ReactivateVariantResultSchema.Type;
