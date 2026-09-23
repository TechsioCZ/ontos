import { Schema } from 'effect';

import { ProductCategoryRefSchema } from '../resources/product-category.ts';

export const CategoryNameSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(240),
  Schema.isTrimmed(),
);
export const CategoryReasonSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1000),
  Schema.isTrimmed(),
);
export const CategoryRevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0));
export const CategoryCounterSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const CategoryRecordSchema = Schema.Struct({
  categoryRef: ProductCategoryRefSchema,
  lifecycle: Schema.Literals(['ACTIVE', 'RETIRED']),
  name: CategoryNameSchema,
  parentRef: Schema.optionalKey(ProductCategoryRefSchema),
  revision: CategoryRevisionSchema,
});

export const CreateProductCategoryPayloadSchema = Schema.Struct({
  name: CategoryNameSchema,
  parentRef: Schema.optionalKey(ProductCategoryRefSchema),
  reason: CategoryReasonSchema,
});
export type CreateProductCategoryPayload = typeof CreateProductCategoryPayloadSchema.Type;

export const CreateProductCategoryResultSchema = Schema.Struct({
  category: CategoryRecordSchema,
  changed: Schema.Boolean,
  hierarchyRevision: CategoryCounterSchema,
});

export class CategoryRevisionConflict extends Schema.TaggedError<CategoryRevisionConflict>()(
  'CategoryRevisionConflict',
  {
    actualRevision: CategoryRevisionSchema,
    categoryRef: ProductCategoryRefSchema,
    code: Schema.Literal('category_revision_conflict'),
    expectedRevision: CategoryRevisionSchema,
    reason: Schema.String,
  },
) {}
