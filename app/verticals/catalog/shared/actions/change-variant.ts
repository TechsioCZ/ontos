import { Schema } from 'effect';

import { ProductEvidenceReferenceSchema, ProductReasonSchema, ProductVariantSchema } from '../domain/product.ts';
import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';

export const VariantChangeClassificationSchema = Schema.Literals([
  'SAME_MEANING_RENAME',
  'EVIDENCED_RECORD_CORRECTION',
  'EVIDENCED_PARENT_CORRECTION',
]);

/** A genuinely new atomic realization must be created under a new Variant identity. */
export const ChangeVariantPayloadSchema = Schema.Struct({
  classification: VariantChangeClassificationSchema,
  currentProductRef: Schema.optionalKey(ProductRefSchema),
  evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
  expectedVariantRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  originalDataErrorEvidenceRef: Schema.optionalKey(ProductEvidenceReferenceSchema),
  reason: ProductReasonSchema,
  targetProductRef: Schema.optionalKey(ProductRefSchema),
  variantRef: VariantRefSchema,
});
export type ChangeVariantPayload = typeof ChangeVariantPayloadSchema.Type;

export const VariantChangeDecisionSchema = Schema.Struct({
  classification: VariantChangeClassificationSchema,
  evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
  reason: ProductReasonSchema,
  targetProductRef: Schema.optionalKey(ProductRefSchema),
  variantRef: VariantRefSchema,
});
export type VariantChangeDecision = typeof VariantChangeDecisionSchema.Type;

export const ChangeVariantResultSchema = Schema.Struct({
  decision: Schema.optionalKey(VariantChangeDecisionSchema),
  variant: ProductVariantSchema,
});
export type ChangeVariantResult = typeof ChangeVariantResultSchema.Type;
