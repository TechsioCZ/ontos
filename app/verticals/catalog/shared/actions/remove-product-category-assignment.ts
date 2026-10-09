import { Schema } from 'effect';

import { CategoryReasonSchema } from './create-product-category.ts';
import { ProductCategoryRefSchema } from '../resources/product-category.ts';
import { ProductRefSchema } from '../resources/product.ts';

export const RemoveProductCategoryAssignmentPayloadSchema = Schema.Struct({
  categoryRef: ProductCategoryRefSchema,
  productRef: ProductRefSchema,
  reason: CategoryReasonSchema,
});
export type RemoveProductCategoryAssignmentPayload = typeof RemoveProductCategoryAssignmentPayloadSchema.Type;
export { AddProductCategoryAssignmentResultSchema as RemoveProductCategoryAssignmentResultSchema } from './add-product-category-assignment.ts';
