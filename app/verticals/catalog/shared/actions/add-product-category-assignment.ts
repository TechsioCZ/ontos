import { Schema } from 'effect';

import { CategoryCounterSchema, CategoryReasonSchema } from './create-product-category.ts';
import { ProductCategoryRefSchema } from '../resources/product-category.ts';
import { ProductRefSchema } from '../resources/product.ts';

export const AddProductCategoryAssignmentPayloadSchema = Schema.Struct({
  categoryRef: ProductCategoryRefSchema,
  productRef: ProductRefSchema,
  reason: CategoryReasonSchema,
});
export type AddProductCategoryAssignmentPayload = typeof AddProductCategoryAssignmentPayloadSchema.Type;
export const AddProductCategoryAssignmentResultSchema = Schema.Struct({
  assignmentRevision: CategoryCounterSchema,
  categoryRef: ProductCategoryRefSchema,
  changed: Schema.Boolean,
  productRef: ProductRefSchema,
});
