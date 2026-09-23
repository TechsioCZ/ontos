import { Schema } from 'effect';

import {
  ProductLifecycleSchema,
  ProductReasonSchema,
  ProductSchema,
  ProductRevisionSchema,
} from '../domain/product.ts';
import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';

export const UpdateProductPayloadSchema = Schema.Struct({
  activateVariantRef: Schema.optionalKey(VariantRefSchema),
  expectedRevision: ProductRevisionSchema,
  productRef: ProductRefSchema,
  reason: ProductReasonSchema,
  targetLifecycle: Schema.optionalKey(ProductLifecycleSchema),
});
export type UpdateProductPayload = typeof UpdateProductPayloadSchema.Type;

export const UpdateProductResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  product: ProductSchema,
});
export type UpdateProductResult = typeof UpdateProductResultSchema.Type;
