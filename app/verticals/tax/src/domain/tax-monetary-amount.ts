import { Option, Schema } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

/** Launch Tax currency is explicit and closed to CZK (#918 F31, #936 F31, #937 F23-F24). */
export const TaxCurrencySchema = Schema.Literal('CZK');
export type TaxCurrency = typeof TaxCurrencySchema.Type;

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

const formatNonNegativeMinorUnits = (minorUnits: bigint): TaxMonetaryAmount => {
  const major = minorUnits / CZK_MINOR_UNITS_PER_MAJOR_UNIT;
  const minor = (minorUnits % CZK_MINOR_UNITS_PER_MAJOR_UNIT).toString().padStart(MINOR_UNIT_DIGITS, '0');
  return { amount: `${major}.${minor}`, currency: 'CZK' };
};

/** Exact CZK minor units (halere) of one published Tax amount. */
export const taxMonetaryAmountMinorUnits = (value: TaxMonetaryAmount): bigint => BigInt(value.amount.replace('.', ''));

/** Builds a published Tax amount from exact minor units; a negative value is not a published sale Tax amount. */
export const taxMonetaryAmountFromMinorUnits = (minorUnits: bigint): Option.Option<TaxMonetaryAmount> =>
  minorUnits < 0n ? Option.none() : Option.some(formatNonNegativeMinorUnits(minorUnits));

/** Exact sum of published Tax amounts; no second rounding happens here (#936 F35-F37). */
export const sumTaxMonetaryAmounts = (amounts: NonEmptyReadonlyArray<TaxMonetaryAmount>): TaxMonetaryAmount =>
  formatNonNegativeMinorUnits(amounts.reduce((total, value) => total + taxMonetaryAmountMinorUnits(value), 0n));
