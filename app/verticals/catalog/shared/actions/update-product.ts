import { Schema } from 'effect';
import { CreateProductPayloadSchema } from './create-product.ts';

import {
  ProductLifecycleSchema,
  ProductReasonSchema,
  ProductSchema,
  ProductRevisionSchema,
} from '../domain/product.ts';
import { ProductRefSchema } from '@app/catalog-selection-contracts/resources/product';
import { VariantRefSchema } from '@app/catalog-selection-contracts/resources/variant';

export const UpdateProductPayloadSchema = Schema.Struct({
  activateVariantRef: Schema.optionalKey(VariantRefSchema),
  expectedRevision: ProductRevisionSchema,
  productRef: ProductRefSchema,
  reason: ProductReasonSchema,
  sourceProduct: Schema.optionalKey(CreateProductPayloadSchema),
  targetLifecycle: Schema.optionalKey(ProductLifecycleSchema),
});
export type UpdateProductPayload = typeof UpdateProductPayloadSchema.Type;

export const UpdateProductResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  product: ProductSchema,
});
export type UpdateProductResult = typeof UpdateProductResultSchema.Type;
