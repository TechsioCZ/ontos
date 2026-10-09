import { Schema } from 'effect';

import {
  ProductDescriptionSchema,
  ProductNameSchema,
  ProductReasonSchema,
  ProductSchema,
  ProductUuidSchema,
} from '../domain/product.ts';
import {
  CompletedProductCreationClassificationSchema,
  ProductCreationClassificationSchema,
} from '../domain/product-change-classification.ts';

export const CreateProductPayloadSchema = Schema.Struct({
  classification: ProductCreationClassificationSchema,
  description: Schema.optionalKey(ProductDescriptionSchema),
  name: Schema.optionalKey(ProductNameSchema),
  reason: ProductReasonSchema,
  variantId: Schema.optionalKey(ProductUuidSchema),
});
export type CreateProductPayload = typeof CreateProductPayloadSchema.Type;

export const CreateProductResultSchema = Schema.Struct({
  classification: Schema.optionalKey(CompletedProductCreationClassificationSchema),
  product: ProductSchema,
  variantId: ProductUuidSchema,
});
export type CreateProductResult = typeof CreateProductResultSchema.Type;
