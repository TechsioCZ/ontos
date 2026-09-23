import { Schema } from 'effect';

import { CategoryReasonSchema, CategoryRevisionSchema, CategoryNameSchema } from './create-product-category.ts';
import { ProductCategoryRefSchema } from '../resources/product-category.ts';

export const RenameProductCategoryPayloadSchema = Schema.Struct({
  categoryRef: ProductCategoryRefSchema,
  expectedRevision: CategoryRevisionSchema,
  name: CategoryNameSchema,
  reason: CategoryReasonSchema,
});
export type RenameProductCategoryPayload = typeof RenameProductCategoryPayloadSchema.Type;
export { CreateProductCategoryResultSchema as RenameProductCategoryResultSchema } from './create-product-category.ts';
