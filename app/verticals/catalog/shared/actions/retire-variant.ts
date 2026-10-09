import { Schema } from 'effect';

import { ProductReasonSchema, ProductVariantSchema } from '../domain/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';

export const RetireVariantPayloadSchema = Schema.Struct({
  expectedVariantRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  reason: ProductReasonSchema,
  variantRef: VariantRefSchema,
});
export type RetireVariantPayload = typeof RetireVariantPayloadSchema.Type;

export const RetireVariantResultSchema = Schema.Struct({ variant: ProductVariantSchema });
export type RetireVariantResult = typeof RetireVariantResultSchema.Type;
