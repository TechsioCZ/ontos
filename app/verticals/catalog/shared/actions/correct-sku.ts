import { Schema } from 'effect';
import { ProductEvidenceReferenceSchema, ProductReasonSchema } from '../domain/product.ts';
import { SkuCodeSchema, SkuTargetSchema } from './assign-sku.ts';

export const CorrectSkuPayloadSchema = Schema.Struct({
  code: SkuCodeSchema,
  evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  previousTarget: SkuTargetSchema,
  reason: ProductReasonSchema,
  target: SkuTargetSchema,
});
export type CorrectSkuPayload = typeof CorrectSkuPayloadSchema.Type;
export const CorrectSkuResultSchema = Schema.Struct({ revision: Schema.Int });
