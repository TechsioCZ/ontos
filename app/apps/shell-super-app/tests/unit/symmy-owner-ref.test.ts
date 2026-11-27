import { ProductCategoryRefSchema } from '@app/catalog/resources/product-category';
import { ProductRefSchema } from '@app/catalog-selection-contracts/resources/product';
import { ProductUnitRefSchema } from '@app/catalog-selection-contracts/resources/product-unit';
import { VariantRefSchema } from '@app/catalog-selection-contracts/resources/variant';
import { PriceGroupRefSchema } from '@app/price-group-catalog-contracts/resources/price-group';
import { PriceRefSchema } from '@app/pricing-contracts/resources/price';
import { describe, expect, it } from 'effect-rstest';

import { symmyOwnerRef } from '../../api/symmy/owner-ref.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const resourceId = '33333333-3333-4333-8333-333333333333';

const reference = (moduleId: string, resourceType: string) => ({ moduleId, resourceId, resourceType, tenantId });

describe('Symmy owner reference of a plain id', () => {
  it('takes the module and resource type of each rebuilt owner reference from its schema', () => {
    expect([
      symmyOwnerRef(ProductUnitRefSchema, tenantId, resourceId),
      symmyOwnerRef(ProductRefSchema, tenantId, resourceId),
      symmyOwnerRef(VariantRefSchema, tenantId, resourceId),
      symmyOwnerRef(ProductCategoryRefSchema, tenantId, resourceId),
      symmyOwnerRef(PriceRefSchema, tenantId, resourceId),
      symmyOwnerRef(PriceGroupRefSchema, tenantId, resourceId),
    ]).toEqual([
      reference('commerce.catalog', 'commerce.catalog.product-unit'),
      reference('commerce.catalog', 'commerce.catalog.product'),
      reference('commerce.catalog', 'commerce.catalog.variant'),
      reference('commerce.catalog', 'commerce.catalog.product-category'),
      reference('commerce.pricing', 'commerce.pricing.price'),
      reference('pricing.price-group-catalog', 'pricing.price-group-catalog.price-group'),
    ]);
  });
});
