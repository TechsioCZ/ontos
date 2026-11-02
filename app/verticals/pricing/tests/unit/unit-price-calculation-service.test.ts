import {
  PricingUnitPriceUnavailableFailure,
  PricingUnitPriceUnverifiableFailure,
} from '@app/pricing-contracts/domain/unit-price-calculation';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { calculatePricingUnitPrice } from '../../src/services/unit-price-calculation.service.ts';
import { unitPriceCalculationAttempt } from './support/unit-price-calculation.fixture.ts';

describe('Pricing Unit Price calculation runtime #778', () => {
  it.effect('multiplies the selected Unit Price by the owner-derived line Quantity exactly', () =>
    Effect.gen(function* multipliesExactly() {
      const attempt = yield* unitPriceCalculationAttempt({ priceAmount: '120', quantity: '2.54' });
      const result = yield* calculatePricingUnitPrice(attempt);

      expect(result.unitPrice).toEqual({ amount: '120', currencyCode: 'CZK' });
      expect(result.baseLineValue).toEqual({ amount: '304.8', currencyCode: 'CZK' });
      expect(result.resultingQuantity).toEqual(result.input.quantityBasis.resultingPurchaseQuantity);
    }),
  );

  it.effect(
    'canonicalizes validated native fixed-scale Price money without changing its retained evidence (#1242)',
    () =>
      Effect.gen(function* nativePriceDecimalLexemes() {
        for (const [priceAmount, canonical] of [
          ['100.000000000', '100'],
          ['0.000000000', '0'],
          ['0.123450000', '0.12345'],
          ['1.000000001', '1.000000001'],
          ['10000000000000000000000000000', '10000000000000000000000000000'],
        ] as const) {
          const attempt = yield* unitPriceCalculationAttempt({ priceAmount, quantity: '1' });
          const result = yield* calculatePricingUnitPrice(attempt);
          expect(result.unitPrice).toEqual({ amount: canonical, currencyCode: 'CZK' });
          expect(result.baseLineValue).toEqual({ amount: canonical, currencyCode: 'CZK' });
          expect(result.input.tierSelection.resultingUnitPrice.amount).toBe(priceAmount);
          expect(result.input.exactPrice).toEqual(attempt.exactPrice);
          expect(result.input.quantityBasis).toEqual(attempt.quantityBasis);
        }
      }),
  );

  it.effect('rejects source scale and range violations before normalizing trailing zeros (#1242)', () =>
    Effect.gen(function* rejectsUnsafeOwnerDecimals() {
      const attempt = yield* unitPriceCalculationAttempt({ priceAmount: '100', quantity: '1' });
      if (attempt.tierSelection.outcome === 'QUANTITY_TIER_SELECTION_FAILED') {
        return yield* Effect.die('Expected a ready Tier result for the source decimal controls');
      }
      for (const amount of ['100.0000000000', '100000000000000000000000000000']) {
        const failure = yield* calculatePricingUnitPrice({
          ...attempt,
          tierSelection: {
            ...attempt.tierSelection,
            resultingUnitPrice: { ...attempt.tierSelection.resultingUnitPrice, amount },
          },
        }).pipe(Effect.flip);
        expect(Schema.is(PricingUnitPriceUnverifiableFailure)(failure)).toBe(true);
        expect(failure).toMatchObject({ reason: 'CURRENTNESS_UNVERIFIABLE' });
        expect(
          yield* unitPriceCalculationAttempt({ priceAmount: amount, quantity: '1' }).pipe(Effect.flip),
        ).toBeInstanceOf(Schema.SchemaError);
      }
      return yield* Effect.void;
    }),
  );

  it.effect('preserves sub-cent precision without applying final-line rounding', () =>
    Effect.gen(function* preservesPrecision() {
      const attempt = yield* unitPriceCalculationAttempt({ priceAmount: '33.335', quantity: '3' });
      const result = yield* calculatePricingUnitPrice(attempt);

      expect(result.baseLineValue).toEqual({ amount: '100.005', currencyCode: 'CZK' });
    }),
  );

  it.effect('keeps an explicit zero Unit Price valid', () =>
    Effect.gen(function* preservesZero() {
      const attempt = yield* unitPriceCalculationAttempt({ priceAmount: '0', quantity: '999.999' });
      const result = yield* calculatePricingUnitPrice(attempt);

      expect(result.unitPrice.amount).toBe('0');
      expect(result.baseLineValue.amount).toBe('0');
    }),
  );

  it.effect('never treats an unavailable Tier set as baseline absence', () =>
    Effect.gen(function* rejectsUnavailableTierSet() {
      const attempt = yield* unitPriceCalculationAttempt({ tierState: 'UNAVAILABLE' });
      const failure = yield* calculatePricingUnitPrice(attempt).pipe(Effect.flip);

      expect(Schema.is(PricingUnitPriceUnavailableFailure)(failure)).toBe(true);
      if (!Schema.is(PricingUnitPriceUnavailableFailure)(failure)) {
        throw new Error('Expected a typed unavailable Tier-set failure');
      }
      expect(failure).toMatchObject({ reason: 'QUANTITY_TIER_UNAVAILABLE', retryable: true });
    }),
  );
});
