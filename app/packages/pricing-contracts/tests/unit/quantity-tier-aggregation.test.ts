import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  sumQuantityTierDecimalValues,
  sumQuantityTierNormalizedQuantities,
} from '../../src/domain/quantity-tier-aggregation.ts';
import { QuantityTierNormalizedQuantitySchema } from '../../src/domain/quantity-tier.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const targetRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};

const quantity = (amount: string, unitRuleRevision = 7) =>
  Schema.decodeSync(QuantityTierNormalizedQuantitySchema)({
    quantity: amount,
    quantityBasis: {
      catalogQuantityBasis: {
        targetDivisibilityRevision: 3,
        targetRef,
        unitRef,
        unitRuleRevision,
      },
      priceUnitBasis: { quantity: '1', unitRef },
    },
  });

describe('Pricing Quantity Tier aggregation exact Quantity helpers', () => {
  it('sums arbitrary-precision decimals without binary floating-point drift', () => {
    expect(sumQuantityTierDecimalValues(['9007199254740993.1', '0.2', '0.70'])).toBe('9007199254740994');
  });

  it('returns one exact normalized Quantity for a compatible owner basis', () => {
    expect(sumQuantityTierNormalizedQuantities([quantity('5'), quantity('5.0')])).toEqual(quantity('10'));
  });

  it('refuses to imply conversion across different owner basis revisions', () => {
    expect(sumQuantityTierNormalizedQuantities([quantity('5'), quantity('5', 8)])).toBeUndefined();
  });
});
