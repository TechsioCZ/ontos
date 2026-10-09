import { Schema } from 'effect';
import { ProductEvidenceReferenceSchema, ProductInstantSchema, ProductReasonSchema } from '../domain/product.ts';
import { GtinCodeSchema, GtinTargetSchema } from './confirm-gtin.ts';

export const RetireGtinPayloadSchema = Schema.Struct({
  attributionEvidenceRef: ProductEvidenceReferenceSchema,
  code: GtinCodeSchema,
  effectiveAt: ProductInstantSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  previousTarget: GtinTargetSchema,
  reason: ProductReasonSchema,
  supersededEvidenceRef: ProductEvidenceReferenceSchema,
});
export type RetireGtinPayload = typeof RetireGtinPayloadSchema.Type;
export const RetireGtinResultSchema = Schema.Struct({ revision: Schema.Int });
