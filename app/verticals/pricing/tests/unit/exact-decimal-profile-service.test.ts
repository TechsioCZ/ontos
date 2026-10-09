import {
  PRICING_ALLOCATION_PROFILE_VERSION,
  PRICING_ARITHMETIC_PROFILE_VERSION,
  PRICING_CZK_PUBLICATION_PROFILE_VERSION,
  PricingExactMoneySchema,
  PricingCurrencyMismatchFailure,
  PricingDecimalOverflowFailure,
  PricingDecimalRangeFailure,
  PricingDecimalScaleFailure,
  PricingUnsupportedProfileFailure,
} from '@app/pricing-contracts/domain/exact-decimal';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  executePricingExactMoneyOperation,
  validatePricingArithmeticContext,
} from '../../src/services/exact-decimal-profile.service.ts';

const profileVersions = {
  allocation: PRICING_ALLOCATION_PROFILE_VERSION,
  arithmetic: PRICING_ARITHMETIC_PROFILE_VERSION,
  publication: PRICING_CZK_PUBLICATION_PROFILE_VERSION,
};

const context = (overrides: Partial<Parameters<typeof validatePricingArithmeticContext>[0]> = {}) => ({
  currencyCode: 'CZK',
  intermediateAmounts: [{ amount: '100.0072', currencyCode: 'CZK' }],
  profileVersions,
  quantities: ['3.25'],
  sourceAmounts: [{ amount: '33.335', currencyCode: 'CZK' }],
  ...overrides,
});

describe('Pricing exact-decimal profile runtime', () => {
  it.effect('resolves the CZK Launch profiles and preserves canonical decimal adapter values losslessly', () =>
    Effect.gen(function* preservesAdapterValues() {
      const result = yield* validatePricingArithmeticContext(context());
      const adapterSchema = Schema.fromJsonString(Schema.Array(PricingExactMoneySchema));
      const encoded = yield* Schema.encodeEffect(adapterSchema)(result.sourceAmounts);
      const transported = yield* Schema.decodeEffect(adapterSchema)(encoded);

      expect(result.outcome).toBe('ARITHMETIC_CONTEXT_READY');
      expect(result.profiles.arithmetic).toMatchObject({ maximumPrecision: 76, maximumScale: 18 });
      expect(result.profiles.allocation).toMatchObject({ maximumPrecision: 76, maximumScale: 18 });
      expect(result.profiles.publication).toEqual({
        currencyCode: 'CZK',
        profileKind: 'PUBLICATION',
        profileVersion: 'pricing-czk-publication-v1',
        publishedScale: 2,
        quantum: '0.01',
        roundingMode: 'HALF_UP',
      });
      expect(transported[0]?.amount).toBe('33.335');
      expect(result.intermediateAmounts[0]?.amount).toBe('100.0072');
      expect(result.quantities[0]).toBe('3.25');
    }),
  );

  it.effect('keeps EUR representable but refuses an unavailable EUR publication profile without fallback', () =>
    Effect.gen(function* rejectsUnavailableEurProfile() {
      const failure = yield* Effect.flip(
        validatePricingArithmeticContext(
          context({
            currencyCode: 'EUR',
            intermediateAmounts: [{ amount: '100.0072', currencyCode: 'EUR' }],
            profileVersions: { ...profileVersions, publication: 'pricing-eur-publication-v1' },
            sourceAmounts: [{ amount: '33.335', currencyCode: 'EUR' }],
          }),
        ),
      );

      expect(failure).toBeInstanceOf(PricingUnsupportedProfileFailure);
      expect(failure).toMatchObject({
        profileKind: 'PUBLICATION',
        requestedProfileVersion: 'pricing-eur-publication-v1',
      });
    }),
  );

  it.effect('rejects applying the CZK publication profile to a different otherwise-compatible currency', () =>
    Effect.gen(function* rejectsCzkProfileForEur() {
      const failure = yield* Effect.flip(
        validatePricingArithmeticContext(
          context({
            currencyCode: 'EUR',
            intermediateAmounts: [{ amount: '100.0072', currencyCode: 'EUR' }],
            sourceAmounts: [{ amount: '33.335', currencyCode: 'EUR' }],
          }),
        ),
      );

      expect(failure).toBeInstanceOf(PricingCurrencyMismatchFailure);
      expect(failure).toMatchObject({ leftCurrencyCode: 'EUR', rightCurrencyCode: 'CZK' });
    }),
  );

  it.effect('rejects a mismatched contributor currency instead of converting, relabeling, or dropping it', () =>
    Effect.gen(function* rejectsMixedCurrencies() {
      const failure = yield* Effect.flip(
        validatePricingArithmeticContext(context({ sourceAmounts: [{ amount: '33.335', currencyCode: 'EUR' }] })),
      );

      expect(failure).toBeInstanceOf(PricingCurrencyMismatchFailure);
      expect(failure).toMatchObject({ leftCurrencyCode: 'CZK', rightCurrencyCode: 'EUR' });
    }),
  );

  it.effect('enforces source amount and Quantity scale independently of the wider intermediate scale', () =>
    Effect.gen(function* rejectsUnsupportedSourceScale() {
      const amountFailure = yield* Effect.flip(
        validatePricingArithmeticContext(context({ sourceAmounts: [{ amount: '1.1234567891', currencyCode: 'CZK' }] })),
      );
      const quantityFailure = yield* Effect.flip(
        validatePricingArithmeticContext(context({ quantities: ['1.1234567891'] })),
      );

      expect(amountFailure).toBeInstanceOf(PricingDecimalScaleFailure);
      expect(amountFailure).toMatchObject({ actualScale: 10, maximumScale: 9 });
      expect(quantityFailure).toBeInstanceOf(PricingDecimalScaleFailure);
      expect(quantityFailure).toMatchObject({ actualScale: 10, maximumScale: 9 });
    }),
  );

  it.effect('accepts 29 source amount integer digits and rejects 30 with a typed range failure', () =>
    Effect.gen(function* validatesSourceAmountIntegerRange() {
      const accepted = '9'.repeat(29);
      const rejected = '9'.repeat(30);
      const ready = yield* validatePricingArithmeticContext(
        context({ sourceAmounts: [{ amount: accepted, currencyCode: 'CZK' }] }),
      );
      const failure = yield* Effect.flip(
        validatePricingArithmeticContext(context({ sourceAmounts: [{ amount: rejected, currencyCode: 'CZK' }] })),
      );

      expect(ready.sourceAmounts[0]?.amount).toBe(accepted);
      expect(failure).toBeInstanceOf(PricingDecimalRangeFailure);
      expect(failure).toMatchObject({ actualIntegerDigits: 30, maximumIntegerDigits: 29 });
    }),
  );

  it.effect('accepts 29 Quantity integer digits and rejects 30 with a typed range failure', () =>
    Effect.gen(function* validatesQuantityIntegerRange() {
      const accepted = '9'.repeat(29);
      const rejected = '9'.repeat(30);
      const ready = yield* validatePricingArithmeticContext(context({ quantities: [accepted] }));
      const failure = yield* Effect.flip(validatePricingArithmeticContext(context({ quantities: [rejected] })));

      expect(ready.quantities[0]).toBe(accepted);
      expect(failure).toBeInstanceOf(PricingDecimalRangeFailure);
      expect(failure).toMatchObject({ actualIntegerDigits: 30, maximumIntegerDigits: 29 });
    }),
  );

  it.effect('accepts scale-18 intermediates and rejects scale-19 without truncation', () =>
    Effect.gen(function* validatesIntermediateScale() {
      const ready = yield* validatePricingArithmeticContext(
        context({ intermediateAmounts: [{ amount: '0.123456789123456789', currencyCode: 'CZK' }] }),
      );
      const failure = yield* Effect.flip(
        validatePricingArithmeticContext(
          context({ intermediateAmounts: [{ amount: '0.1234567891234567891', currencyCode: 'CZK' }] }),
        ),
      );

      expect(ready.intermediateAmounts[0]?.amount).toBe('0.123456789123456789');
      expect(failure).toBeInstanceOf(PricingDecimalScaleFailure);
      expect(failure).toMatchObject({ actualScale: 19, maximumScale: 18 });
    }),
  );

  it.effect('rejects out-of-range values without fabricating a safe amount', () =>
    Effect.gen(function* rejectsOutOfRangeValue() {
      const failure = yield* Effect.flip(
        validatePricingArithmeticContext(
          context({ intermediateAmounts: [{ amount: '1'.repeat(59), currencyCode: 'CZK' }] }),
        ),
      );

      expect(failure).toBeInstanceOf(PricingDecimalRangeFailure);
      expect(failure).toMatchObject({ actualIntegerDigits: 59, maximumIntegerDigits: 58 });
    }),
  );

  it.effect('multiplies canonical amount and Quantity exactly without binary floating point or rounding', () =>
    Effect.gen(function* multipliesExactly() {
      const result = yield* executePricingExactMoneyOperation({
        currencyCode: 'CZK',
        operation: 'MULTIPLY_AMOUNT_BY_QUANTITY',
        quantity: '3',
        sourceAmount: { amount: '33.335', currencyCode: 'CZK' },
      });

      expect(result).toEqual({ amount: '100.005', currencyCode: 'CZK' });
    }),
  );

  it.effect('fails typed on arithmetic overflow instead of truncating the result', () =>
    Effect.gen(function* rejectsOverflow() {
      const failure = yield* Effect.flip(
        executePricingExactMoneyOperation({
          currencyCode: 'CZK',
          left: { amount: '9'.repeat(58), currencyCode: 'CZK' },
          operation: 'ADD',
          right: { amount: '1', currencyCode: 'CZK' },
        }),
      );

      expect(failure).toBeInstanceOf(PricingDecimalOverflowFailure);
      expect(failure).toMatchObject({ limitKind: 'INTEGER_DIGITS', operation: 'ADD' });
    }),
  );

  it.effect('adds and subtracts exact compatible intermediates while rejecting mixed currencies', () =>
    Effect.gen(function* calculatesCompatibleIntermediates() {
      const sum = yield* executePricingExactMoneyOperation({
        currencyCode: 'CZK',
        left: { amount: '0.1', currencyCode: 'CZK' },
        operation: 'ADD',
        right: { amount: '0.2', currencyCode: 'CZK' },
      });
      const difference = yield* executePricingExactMoneyOperation({
        currencyCode: 'CZK',
        left: { amount: '100.0072', currencyCode: 'CZK' },
        operation: 'SUBTRACT',
        right: { amount: '100', currencyCode: 'CZK' },
      });
      const failure = yield* Effect.flip(
        executePricingExactMoneyOperation({
          currencyCode: 'CZK',
          left: { amount: '1', currencyCode: 'CZK' },
          operation: 'ADD',
          right: { amount: '1', currencyCode: 'EUR' },
        }),
      );

      expect(sum).toEqual({ amount: '0.3', currencyCode: 'CZK' });
      expect(difference).toEqual({ amount: '0.0072', currencyCode: 'CZK' });
      expect(failure).toBeInstanceOf(PricingCurrencyMismatchFailure);
    }),
  );
});
