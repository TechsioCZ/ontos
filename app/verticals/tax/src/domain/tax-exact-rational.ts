import { Option, Schema } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

/*
 * Exact Tax values and arithmetic over bigint numerator/denominator pairs. Finite decimals stay exact and
 * division-derived intermediates stay exact rationals until the final Tax rounding boundary; binary floating point
 * is never used (#935 F1-F2, F12-F19; #907 F95-F96).
 */

const integerPattern = /^(?:0|-?[1-9]\d*)$/u;
const positiveIntegerPattern = /^[1-9]\d*$/u;
const decimalPattern = /^(?<sign>-?)(?<integerDigits>0|[1-9]\d*)(?:\.(?<fractionDigits>\d+))?$/u;

const absolute = (value: bigint) => (value < 0n ? -value : value);

const greatestCommonDivisor = (left: bigint, right: bigint): bigint => {
  let first = absolute(left);
  let second = absolute(right);
  while (second !== 0n) {
    [first, second] = [second, first % second];
  }
  return first;
};

/**
 * Exact rational value in lowest terms with a positive denominator. Tax arithmetic keeps finite decimals
 * and division-derived intermediates exact until the final Tax rounding boundary (#907 F95-F96).
 */
export const TaxExactRationalSchema = Schema.Struct({
  denominator: Schema.String.check(Schema.isPattern(positiveIntegerPattern)),
  numerator: Schema.String.check(Schema.isPattern(integerPattern)),
}).check(
  Schema.makeFilter(
    ({ denominator, numerator }) =>
      greatestCommonDivisor(BigInt(numerator), BigInt(denominator)) === 1n ||
      'An exact Tax rational must be stored in lowest terms',
  ),
);
export type TaxExactRational = typeof TaxExactRationalSchema.Type;

export const isNonNegativeTaxExactRational = (value: TaxExactRational) => !value.numerator.startsWith('-');

/** Exact non-negative value, e.g. an owner-issued commercial amount, a Taxable Basis component or a weight. */
export const NonNegativeTaxExactRationalSchema = TaxExactRationalSchema.check(
  Schema.makeFilter((value) => isNonNegativeTaxExactRational(value) || 'The exact value must be non-negative'),
);

export const ZERO_TAX_EXACT_RATIONAL: TaxExactRational = { denominator: '1', numerator: '0' };

/** Lowest terms with a positive denominator; the denominator must not be zero. */
const normalize = (numerator: bigint, denominator: bigint): TaxExactRational => {
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = greatestCommonDivisor(numerator, denominator);
  return {
    denominator: ((sign * denominator) / divisor).toString(),
    numerator: ((sign * numerator) / divisor).toString(),
  };
};

/** Normalizes an exact fraction; a zero denominator has no exact value. */
export const makeTaxExactRational = (numerator: bigint, denominator: bigint): Option.Option<TaxExactRational> =>
  denominator === 0n ? Option.none() : Option.some(normalize(numerator, denominator));

/** Reads a canonical base-10 decimal string exactly, without binary floating point. */
export const taxExactRationalFromDecimal = (value: string): Option.Option<TaxExactRational> => {
  const groups = decimalPattern.exec(value)?.groups;
  if (groups === undefined) {
    return Option.none();
  }
  const { fractionDigits = '', integerDigits = '0', sign = '' } = groups;
  return makeTaxExactRational(BigInt(`${sign}${integerDigits}${fractionDigits}`), 10n ** BigInt(fractionDigits.length));
};

/** Exact value of an integer count of minor units at the given (positive) number of minor units per major unit. */
export const taxExactRationalFromMinorUnits = (minorUnits: bigint, minorUnitsPerMajorUnit: bigint): TaxExactRational =>
  normalize(minorUnits, minorUnitsPerMajorUnit);

const partsOf = (value: TaxExactRational) => ({
  denominator: BigInt(value.denominator),
  numerator: BigInt(value.numerator),
});

export const addTaxExactRationals = (left: TaxExactRational, right: TaxExactRational): TaxExactRational => {
  const a = partsOf(left);
  const b = partsOf(right);
  return normalize(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
};

export const subtractTaxExactRationals = (left: TaxExactRational, right: TaxExactRational): TaxExactRational => {
  const b = partsOf(right);
  return addTaxExactRationals(left, normalize(-b.numerator, b.denominator));
};

export const multiplyTaxExactRationals = (left: TaxExactRational, right: TaxExactRational): TaxExactRational => {
  const a = partsOf(left);
  const b = partsOf(right);
  return normalize(a.numerator * b.numerator, a.denominator * b.denominator);
};

/** Exact quotient; dividing by zero has no exact value. */
export const divideTaxExactRationals = (
  dividend: TaxExactRational,
  divisor: TaxExactRational,
): Option.Option<TaxExactRational> => {
  const a = partsOf(dividend);
  const b = partsOf(divisor);
  return makeTaxExactRational(a.numerator * b.denominator, a.denominator * b.numerator);
};

export const sumTaxExactRationals = (values: NonEmptyReadonlyArray<TaxExactRational>): TaxExactRational => {
  let total = ZERO_TAX_EXACT_RATIONAL;
  for (const value of values) {
    total = addTaxExactRationals(total, value);
  }
  return total;
};

/** Lowest-terms values with a positive denominator are equal exactly when their parts are equal. */
export const taxExactRationalsEqual = (left: TaxExactRational, right: TaxExactRational): boolean =>
  left.numerator === right.numerator && left.denominator === right.denominator;

/**
 * ROUND_HALF_UP of a non-negative exact value to whole minor units: the nearest minor unit, with an exact
 * midpoint going up (#935 F21-F22). Negative values have no Launch publication meaning and give none.
 */
export const roundNonNegativeHalfUpToMinorUnits = (
  value: TaxExactRational,
  minorUnitsPerMajorUnit: bigint,
): Option.Option<bigint> => {
  const { denominator, numerator } = partsOf(value);
  return numerator < 0n
    ? Option.none()
    : Option.some((2n * numerator * minorUnitsPerMajorUnit + denominator) / (2n * denominator));
};
