import { Schema } from 'effect';
import { ProductEvidenceReferenceSchema, ProductInstantSchema, ProductReasonSchema } from '../domain/product.ts';
import { GtinCodeSchema, GtinTargetSchema } from './confirm-gtin.ts';

export const MarkGtinUnresolvedPayloadSchema = Schema.Struct({
  attributionEvidenceRef: ProductEvidenceReferenceSchema,
  code: GtinCodeSchema,
  effectiveAt: ProductInstantSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  previousTarget: GtinTargetSchema,
  reason: ProductReasonSchema,
  supersededEvidenceRef: ProductEvidenceReferenceSchema,
});
export type MarkGtinUnresolvedPayload = typeof MarkGtinUnresolvedPayloadSchema.Type;
export const MarkGtinUnresolvedResultSchema = Schema.Struct({ revision: Schema.Int });
