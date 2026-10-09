import { Schema } from 'effect';

import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';

/**
 * Catalog identity is scoped by Tenant only. Selling Legal Entity, channel, and commercial
 * conditions are deliberately absent because they do not create another Product identity.
 */
export const CatalogIdentityScopeSchema = Schema.Struct({
  productRef: ProductRefSchema,
  variantRef: VariantRefSchema,
}).check(
  Schema.makeFilter(({ productRef, variantRef }) =>
    productRef.tenantId === variantRef.tenantId
      ? []
      : [
          {
            issue: 'Product and Variant references must share one Tenant',
            path: ['variantRef', 'tenantId'],
          },
        ],
  ),
);
export type CatalogIdentityScope = typeof CatalogIdentityScopeSchema.Type;
