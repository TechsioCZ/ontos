import { Schema } from 'effect';

import { CategoryReasonSchema, CategoryRevisionSchema } from './create-product-category.ts';
import { ProductCategoryRefSchema } from '../resources/product-category.ts';

export const MoveProductCategoryPayloadSchema = Schema.Struct({
  categoryRef: ProductCategoryRefSchema,
  expectedRevision: CategoryRevisionSchema,
  parentRef: Schema.optionalKey(ProductCategoryRefSchema),
  reason: CategoryReasonSchema,
});
export type MoveProductCategoryPayload = typeof MoveProductCategoryPayloadSchema.Type;
export { CreateProductCategoryResultSchema as MoveProductCategoryResultSchema } from './create-product-category.ts';
