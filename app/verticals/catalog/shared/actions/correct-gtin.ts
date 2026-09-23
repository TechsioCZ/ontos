import { Schema } from 'effect';
import { ProductEvidenceReferenceSchema, ProductInstantSchema, ProductReasonSchema } from '../domain/product.ts';
import { GtinCodeSchema, GtinTargetSchema } from './confirm-gtin.ts';

export const CorrectGtinPayloadSchema = Schema.Struct({
  attributionEvidenceRef: ProductEvidenceReferenceSchema,
  code: GtinCodeSchema,
  effectiveAt: ProductInstantSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  previousTarget: GtinTargetSchema,
  reason: ProductReasonSchema,
  supersededEvidenceRef: ProductEvidenceReferenceSchema,
  target: GtinTargetSchema,
});
export type CorrectGtinPayload = typeof CorrectGtinPayloadSchema.Type;
export const CorrectGtinResultSchema = Schema.Struct({ revision: Schema.Int });
