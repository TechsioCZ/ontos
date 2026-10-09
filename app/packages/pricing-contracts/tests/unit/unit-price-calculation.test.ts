import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingUnitPriceBasisFailure,
  PricingUnitPriceCalculationFailureSchema,
  PricingUnitPriceCalculationReadyInputSchema,
  PricingUnitPriceCalculationResultSchema,
  PricingUnitPriceConflictFailure,
  PricingUnitPriceCurrencyFailure,
  PricingUnitPriceInvalidFailure,
  PricingUnitPriceInvalidReasonSchema,
  PricingUnitPriceMoneySchema,
  PricingUnitPricePrecisionFailure,
  PricingUnitPriceUnavailableFailure,
  PricingUnitPriceUnverifiableFailure,
} from '../../src/domain/unit-price-calculation.ts';

describe('Pricing Unit Price calculation contract #778', () => {
  it('keeps exact zero valid and currency generic without activating another publication profile', () => {
    expect(Schema.decodeSync(PricingUnitPriceMoneySchema)({ amount: '0', currencyCode: 'CZK' })).toEqual({
      amount: '0',
      currencyCode: 'CZK',
    });
    expect(Schema.decodeSync(PricingUnitPriceMoneySchema)({ amount: '120.25', currencyCode: 'EUR' })).toEqual({
      amount: '120.25',
      currencyCode: 'EUR',
    });
    expect(Schema.is(PricingUnitPriceMoneySchema)({ amount: '-0.01', currencyCode: 'CZK' })).toBe(false);
    expect(Schema.is(PricingUnitPriceMoneySchema)({ amount: '120.250', currencyCode: 'CZK' })).toBe(false);
  });

  it('exposes distinct typed failure contracts instead of a fallback result', () => {
    expect(PricingUnitPriceCalculationFailureSchema.members).toEqual([
      PricingUnitPriceInvalidFailure,
      PricingUnitPriceConflictFailure,
      PricingUnitPriceUnavailableFailure,
      PricingUnitPriceUnverifiableFailure,
      PricingUnitPricePrecisionFailure,
      PricingUnitPriceCurrencyFailure,
      PricingUnitPriceBasisFailure,
    ]);
    expect(Schema.is(PricingUnitPriceInvalidReasonSchema)('NO_APPLICABLE_PRICE')).toBe(true);
    expect(Schema.is(PricingUnitPriceInvalidReasonSchema)('PRODUCT_ONLY_FALLBACK')).toBe(false);
  });

  it('does not admit a calculation success without the exact owner-bound material evidence', () => {
    expect(Schema.is(PricingUnitPriceCalculationReadyInputSchema)({})).toBe(false);
    expect(
      Schema.is(PricingUnitPriceCalculationResultSchema)({
        _tag: 'UNIT_PRICE_CALCULATED',
        arithmeticProfileVersion: 'pricing-arithmetic-v1',
        baseLineValue: { amount: '304.8', currencyCode: 'CZK' },
        monetaryBoundary: 'PRE_TAX',
        resultingQuantity: { amount: '2.54' },
        unitPrice: { amount: '120', currencyCode: 'CZK' },
      }),
    ).toBe(false);
  });
});
