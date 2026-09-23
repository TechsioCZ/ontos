import { Schema } from 'effect';

import { CategoryReasonSchema, CategoryRevisionSchema } from './create-product-category.ts';
import { ProductCategoryRefSchema } from '../resources/product-category.ts';

export const RetireProductCategoryPayloadSchema = Schema.Struct({
  categoryRef: ProductCategoryRefSchema,
  expectedRevision: CategoryRevisionSchema,
  reason: CategoryReasonSchema,
});
export type RetireProductCategoryPayload = typeof RetireProductCategoryPayloadSchema.Type;
export { CreateProductCategoryResultSchema as RetireProductCategoryResultSchema } from './create-product-category.ts';
