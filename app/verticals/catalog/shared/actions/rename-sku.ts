import { Schema } from 'effect';
import { ProductEvidenceReferenceSchema, ProductReasonSchema } from '../domain/product.ts';
import { SkuCodeSchema, SkuTargetSchema } from './assign-sku.ts';

export const RenameSkuPayloadSchema = Schema.Struct({
  code: SkuCodeSchema,
  evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  oldCode: SkuCodeSchema,
  reason: ProductReasonSchema,
  target: SkuTargetSchema,
});
export type RenameSkuPayload = typeof RenameSkuPayloadSchema.Type;
export const RenameSkuResultSchema = Schema.Struct({ revision: Schema.Int });
