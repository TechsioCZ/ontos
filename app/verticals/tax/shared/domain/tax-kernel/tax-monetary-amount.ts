import { Schema } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import { roundHalfUpToMinorUnits } from './tax-exact-rational.ts';
import type { NonNegativeTaxExactRational } from './tax-exact-rational.ts';

/** Launch Tax currency is explicit and closed to CZK (#918 F31, #936 F31, #937 F23-F24). */
export const TaxCurrencySchema = Schema.Literal('CZK');

const publishedTaxAmountPattern = /^(?:0|[1-9]\d*)\.\d{2}$/u;

/**
 * Exact non-negative decimal string published at 0.01 CZK (#936 F33). It is never a binary float and
 * never stands for a missing or failed Tax amount (#936 F26, #939 F10).
 */
export const TaxPublishedAmountSchema = Schema.String.check(Schema.isPattern(publishedTaxAmountPattern));

/** Tax Monetary Amount with explicit currency (#936 F30-F31, #940 F21). */
export const TaxMonetaryAmountSchema = Schema.Struct({
  amount: TaxPublishedAmountSchema,
  currency: TaxCurrencySchema,
});
export type TaxMonetaryAmount = typeof TaxMonetaryAmountSchema.Type;

/** CZK minor units (haléře) per koruna at the published 0.01 CZK precision (#936 F33). */
export const CZK_MINOR_UNITS_PER_MAJOR_UNIT = 100n;
const MINOR_UNIT_DIGITS = 2;

/**
 * Published Tax amount of a non-negative count of exact CZK minor units. Module-private: its only sources are
 * HALF_UP of a non-negative exact value and sums of published amounts, so the count is never negative.
 */
const taxMonetaryAmountFromNonNegativeMinorUnits = (minorUnits: bigint): TaxMonetaryAmount => {
  const major = minorUnits / CZK_MINOR_UNITS_PER_MAJOR_UNIT;
  const minor = (minorUnits % CZK_MINOR_UNITS_PER_MAJOR_UNIT).toString().padStart(MINOR_UNIT_DIGITS, '0');
  return { amount: `${major}.${minor}`, currency: 'CZK' };
};

/** Published CZK Tax amount of a non-negative exact value, ROUND_HALF_UP at 0.01 CZK (#935 F21-F22, #936 F33). */
export const publishedTaxAmountRoundedHalfUp = (value: NonNegativeTaxExactRational): TaxMonetaryAmount =>
  taxMonetaryAmountFromNonNegativeMinorUnits(roundHalfUpToMinorUnits(value, CZK_MINOR_UNITS_PER_MAJOR_UNIT));

/** Exact CZK minor units (halere) of one published Tax amount. */
export const taxMonetaryAmountMinorUnits = (value: TaxMonetaryAmount): bigint => BigInt(value.amount.replace('.', ''));

const signedTaxAmountPattern = /^-?(?:0|[1-9]\d*)\.\d{2}$/u;

/**
 * Signed Tax difference at 0.01 CZK, e.g. a Tax Correction Delta between two published cumulative Tax states. It is
 * a difference of published amounts, never itself rounded and never a published Tax amount (#948 F19-F20).
 */
export const SignedTaxMonetaryAmountSchema = Schema.Struct({
  amount: Schema.String.check(
    Schema.isPattern(signedTaxAmountPattern),
    Schema.makeFilter((amount) => amount !== '-0.00' || 'A zero Tax difference has no sign'),
  ),
  currency: TaxCurrencySchema,
});
export type SignedTaxMonetaryAmount = typeof SignedTaxMonetaryAmountSchema.Type;

/** Signed Tax difference of an exact signed count of CZK minor units. */
export const signedTaxMonetaryAmountFromMinorUnits = (minorUnits: bigint): SignedTaxMonetaryAmount => {
  const magnitude = taxMonetaryAmountFromNonNegativeMinorUnits(minorUnits < 0n ? -minorUnits : minorUnits);
  return { amount: minorUnits < 0n ? `-${magnitude.amount}` : magnitude.amount, currency: 'CZK' };
};

/** Exact signed CZK minor units of one signed Tax difference. */
export const signedTaxMonetaryAmountMinorUnits = (value: SignedTaxMonetaryAmount): bigint =>
  BigInt(value.amount.replace('.', ''));

/** Exact sum of published Tax amounts; no second rounding happens here (#936 F35-F37). */
export const sumTaxMonetaryAmounts = (amounts: NonEmptyReadonlyArray<TaxMonetaryAmount>): TaxMonetaryAmount =>
  taxMonetaryAmountFromNonNegativeMinorUnits(
    amounts.reduce((total, value) => total + taxMonetaryAmountMinorUnits(value), 0n),
  );
