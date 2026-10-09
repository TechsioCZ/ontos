import { Schema } from 'effect';

import { ProductReasonSchema, ProductRevisionSchema } from '../domain/product.ts';
import { ProductRefSchema } from '../resources/product.ts';
import { ProductTypeRefSchema } from '../resources/product-type.ts';

/** A caller-held preview token is intent, not authority; the Action must verify it. */
export const SetProductTypePayloadSchema = Schema.Struct({
  expectedProductRevision: ProductRevisionSchema,
  impactBasis: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  nextProductTypeRef: Schema.optionalKey(ProductTypeRefSchema),
  productRef: ProductRefSchema,
  reason: ProductReasonSchema,
}).check(
  Schema.makeFilter(({ nextProductTypeRef, productRef }) =>
    nextProductTypeRef === undefined || nextProductTypeRef.tenantId === productRef.tenantId
      ? undefined
      : 'Product and next Product Type must belong to the same Tenant',
  ),
);
export type SetProductTypePayload = typeof SetProductTypePayloadSchema.Type;

export const SetProductTypeResultSchema = Schema.Struct({
  currentProductTypeRef: Schema.optionalKey(ProductTypeRefSchema),
  productRef: ProductRefSchema,
  revision: ProductRevisionSchema,
  unresolvedProductRefs: Schema.Array(ProductRefSchema),
});
export type SetProductTypeResult = typeof SetProductTypeResultSchema.Type;
