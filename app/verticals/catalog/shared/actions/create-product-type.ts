import { Schema } from 'effect';

import { CatalogRevisionNumberSchema } from '../domain/catalog-revision-reference.ts';
import { ProductNameSchema, ProductReasonSchema } from '../domain/product.ts';
import { ProductTypeAttributeRuleSchema } from '../domain/product-type-rules.ts';
import { ProductTypeRefSchema } from '../resources/product-type.ts';

/** The initial rules revision is explicit, including an intentionally empty rule set. */
export const CreateProductTypePayloadSchema = Schema.Struct({
  name: ProductNameSchema,
  reason: ProductReasonSchema,
  rules: Schema.Array(ProductTypeAttributeRuleSchema),
});
export type CreateProductTypePayload = typeof CreateProductTypePayloadSchema.Type;

export const CreateProductTypeResultSchema = Schema.Struct({
  productTypeRef: ProductTypeRefSchema,
  revision: CatalogRevisionNumberSchema,
});
export type CreateProductTypeResult = typeof CreateProductTypeResultSchema.Type;
