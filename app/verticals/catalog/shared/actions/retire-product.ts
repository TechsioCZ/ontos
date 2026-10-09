import { Schema } from 'effect';

import { ProductInstantSchema, ProductReasonSchema, ProductSchema, ProductRevisionSchema } from '../domain/product.ts';
import { ProductRefSchema } from '../resources/product.ts';

export const RetireProductPayloadSchema = Schema.Struct({
  effectiveAt: Schema.optionalKey(ProductInstantSchema),
  expectedRevision: ProductRevisionSchema,
  productRef: ProductRefSchema,
  reason: ProductReasonSchema,
});
export type RetireProductPayload = typeof RetireProductPayloadSchema.Type;

export const RetireProductResultSchema = Schema.Struct({
  product: ProductSchema,
});
export type RetireProductResult = typeof RetireProductResultSchema.Type;
