import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PRICING_ALLOCATION_PROFILE,
  PRICING_ALLOCATION_PROFILE_VERSION,
  PRICING_ARITHMETIC_PROFILE,
  PRICING_ARITHMETIC_PROFILE_VERSION,
  PRICING_CZK_PUBLICATION_PROFILE,
  PricingCurrencyMismatchFailure,
  PricingDecimalFormatFailure,
  PricingDecimalOverflowFailure,
  PricingDecimalRangeFailure,
  PricingDecimalScaleFailure,
  PricingDecimalSignFailure,
  PricingExactDecimalSchema,
  PricingExactMoneySchema,
  PricingUnsupportedProfileFailure,
  addPricingExactDecimals,
  comparePricingExactDecimals,
  ensurePricingDecimalSign,
  ensurePricingMoneyCurrencyCompatibility,
  formatPricingExactDecimal,
  multiplyPricingExactDecimals,
  parsePricingExactDecimal,
  resolvePricingAllocationProfile,
  resolvePricingArithmeticProfile,
  resolvePricingPublicationProfile,
  subtractPricingExactDecimals,
} from '../../src/domain/exact-decimal.ts';
import { PriceNonNegativeDecimalSchema } from '../../src/domain/price-definition.ts';

describe('Pricing exact decimal', () => {
  it.effect('round-trips canonical signed base-10 values without binary floating point', () =>
    Effect.gen(function* roundTripCanonicalDecimals() {
      for (const value of ['0', '1', '-1', '10.01', '-0.000000001', '99999999999999999999999999999.123456789']) {
        const parsed = yield* parsePricingExactDecimal(value);
        expect(formatPricingExactDecimal(parsed)).toBe(value);
        expect(yield* Schema.decodeEffect(PricingExactDecimalSchema)(value)).toBe(value);
      }
    }),
  );

  it.effect('rejects non-canonical notation, scale, and range with distinct typed failures', () =>
    Effect.gen(function* rejectInvalidDecimals() {
      for (const value of ['1.0', '01', '+1', '-0', '1e3', ' 1']) {
        const failure = yield* parsePricingExactDecimal(value).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(PricingDecimalFormatFailure);
      }

      const scaleFailure = yield* parsePricingExactDecimal('0.0000000000000000001').pipe(Effect.flip);
      expect(scaleFailure).toBeInstanceOf(PricingDecimalScaleFailure);

      const rangeFailure = yield* parsePricingExactDecimal('1'.repeat(59)).pipe(Effect.flip);
      expect(rangeFailure).toBeInstanceOf(PricingDecimalRangeFailure);
    }),
  );

  it.effect('adds and subtracts exactly across different scales', () =>
    Effect.gen(function* addAndSubtractExactly() {
      expect(yield* addPricingExactDecimals('100.0072', '-100')).toBe('0.0072');
      expect(yield* subtractPricingExactDecimals('0.1', '0.000000000000000001')).toBe('0.099999999999999999');
      expect(yield* addPricingExactDecimals('-4.25', '4.25')).toBe('0');
    }),
  );

  it.effect('multiplies the required sub-cent allocation fixture exactly', () =>
    Effect.gen(function* multiplyExactly() {
      expect(yield* multiplyPricingExactDecimals('10.01', '0.97')).toBe('9.7097');
      expect(yield* multiplyPricingExactDecimals('95.05', '0.95')).toBe('90.2975');
      expect(yield* addPricingExactDecimals('9.7097', '90.2975')).toBe('100.0072');
    }),
  );

  it.effect('preserves additive identity, self-subtraction, and comparison antisymmetry over edge values', () =>
    Effect.gen(function* proveArithmeticProperties() {
      const values = ['-999.999', '-0.000000000000000001', '0', '0.1', '999999999999.999999999999999999'];
      for (const value of values) {
        expect(yield* addPricingExactDecimals(value, '0')).toBe(value);
        expect(yield* subtractPricingExactDecimals(value, value)).toBe('0');
      }
      for (const left of values) {
        for (const right of values) {
          expect(comparePricingExactDecimals(left, right) + comparePricingExactDecimals(right, left)).toBe(0);
        }
      }
    }),
  );

  it.effect('fails closed on arithmetic scale and integer overflow without truncation', () =>
    Effect.gen(function* rejectArithmeticOverflow() {
      const scaleOverflow = yield* multiplyPricingExactDecimals('0.000000000000000001', '0.1').pipe(Effect.flip);
      expect(scaleOverflow).toBeInstanceOf(PricingDecimalOverflowFailure);
      expect(scaleOverflow).toMatchObject({ limitKind: 'SCALE' });

      const largestInteger = '9'.repeat(58);
      const integerOverflow = yield* addPricingExactDecimals(largestInteger, largestInteger).pipe(Effect.flip);
      expect(integerOverflow).toBeInstanceOf(PricingDecimalOverflowFailure);
      expect(integerOverflow).toMatchObject({ limitKind: 'INTEGER_DIGITS' });
    }),
  );

  it.effect('enforces requested sign semantics without reinterpreting zero', () =>
    Effect.gen(function* enforceSignSemantics() {
      expect(yield* ensurePricingDecimalSign('0', 'NON_NEGATIVE')).toBe('0');
      expect(yield* ensurePricingDecimalSign('0', 'NON_POSITIVE')).toBe('0');
      const failure = yield* ensurePricingDecimalSign('0', 'POSITIVE').pipe(Effect.flip);
      expect(failure).toBeInstanceOf(PricingDecimalSignFailure);
    }),
  );

  it.effect('keeps currency explicit and rejects cross-currency arithmetic compatibility', () =>
    Effect.gen(function* enforceCurrencyCompatibility() {
      const czk = yield* Schema.decodeEffect(PricingExactMoneySchema)({ amount: '10.01', currencyCode: 'CZK' });
      const eur = yield* Schema.decodeEffect(PricingExactMoneySchema)({ amount: '10.01', currencyCode: 'EUR' });
      expect(yield* ensurePricingMoneyCurrencyCompatibility(czk, czk)).toBe('CZK');
      const failure = yield* ensurePricingMoneyCurrencyCompatibility(czk, eur).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(PricingCurrencyMismatchFailure);
    }),
  );

  it.effect('resolves only declared immutable profile versions', () =>
    Effect.gen(function* resolveDeclaredProfiles() {
      expect(yield* resolvePricingArithmeticProfile(PRICING_ARITHMETIC_PROFILE_VERSION)).toEqual(
        PRICING_ARITHMETIC_PROFILE,
      );
      expect(yield* resolvePricingAllocationProfile(PRICING_ALLOCATION_PROFILE_VERSION)).toEqual(
        PRICING_ALLOCATION_PROFILE,
      );
      expect(yield* resolvePricingPublicationProfile('pricing-czk-publication-v1')).toEqual(
        PRICING_CZK_PUBLICATION_PROFILE,
      );
      const failure = yield* resolvePricingArithmeticProfile('pricing-arithmetic-v2').pipe(Effect.flip);
      expect(failure).toBeInstanceOf(PricingUnsupportedProfileFailure);
    }),
  );

  it('distinguishes the numeric(38, 9) source boundary from the 76/18 intermediate envelope', () => {
    expect(PRICING_ARITHMETIC_PROFILE).toMatchObject({
      acceptedSourceAmountPrecision: 38,
      acceptedSourceAmountScale: 9,
      maximumIntegerDigits: 58,
      maximumPrecision: 76,
      maximumScale: 18,
      maximumSourceAmountIntegerDigits: 29,
    });
    expect(Schema.decodeSync(PriceNonNegativeDecimalSchema)('9'.repeat(29))).toBe('9'.repeat(29));
    expect(() => Schema.decodeSync(PriceNonNegativeDecimalSchema)('9'.repeat(30))).toThrow();
    expect(Schema.is(PricingExactDecimalSchema)('9'.repeat(30))).toBe(true);
  });

  it('declares generalized exact money while limiting the Launch publication profile to CZK', () => {
    expect(Schema.is(PricingExactMoneySchema)({ amount: '1', currencyCode: 'EUR' })).toBe(true);
    expect(PRICING_CZK_PUBLICATION_PROFILE).toMatchObject({
      currencyCode: 'CZK',
      publishedScale: 2,
      quantum: '0.01',
      roundingMode: 'HALF_UP',
    });
  });
});
