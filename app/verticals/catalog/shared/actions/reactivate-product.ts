import { Schema } from 'effect';

import { ProductReasonSchema, ProductSchema, ProductRevisionSchema } from '../domain/product.ts';
import { ProductRefSchema } from '../resources/product.ts';

export const ReactivateProductPayloadSchema = Schema.Struct({
  expectedRevision: ProductRevisionSchema,
  productRef: ProductRefSchema,
  reason: ProductReasonSchema,
});
export type ReactivateProductPayload = typeof ReactivateProductPayloadSchema.Type;

export const ReactivateProductResultSchema = Schema.Struct({
  product: ProductSchema,
});
export type ReactivateProductResult = typeof ReactivateProductResultSchema.Type;
