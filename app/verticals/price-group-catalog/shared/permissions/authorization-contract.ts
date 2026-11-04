import type { OwnerPermissionContract } from '@app/core-runtime';
import { pricingPriceGroupCreatePermission } from './pricing-price-group-create.ts';
import { pricingPriceGroupReadPermission } from './pricing-price-group-read.ts';
import { pricingPriceGroupRetirePermission } from './pricing-price-group-retire.ts';
import { pricingPriceGroupRevisionCreatePermission } from './pricing-price-group-revision-create.ts';

export const priceGroupAuthorizationContract = Object.freeze({
  owningModuleKey: 'pricing.price-group-catalog',
  permissions: Object.freeze([
    pricingPriceGroupCreatePermission,
    pricingPriceGroupReadPermission,
    pricingPriceGroupRetirePermission,
    pricingPriceGroupRevisionCreatePermission,
  ]),
  schemaVersion: '1',
  targetResourceType: 'business_permission',
}) satisfies OwnerPermissionContract;
