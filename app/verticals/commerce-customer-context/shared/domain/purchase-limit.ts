import { Schema } from 'effect';
import { CurrencyCodeSchema } from './currency.ts';

const PURCHASE_LIMIT_DECIMAL_PRECISION = 38;
const PURCHASE_LIMIT_DECIMAL_SCALE = 9;
const PURCHASE_LIMIT_DECIMAL_INTEGER_DIGITS = PURCHASE_LIMIT_DECIMAL_PRECISION - PURCHASE_LIMIT_DECIMAL_SCALE;

const canonicalDecimalPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/u;

export const ExactNonNegativeDecimalSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    if (!canonicalDecimalPattern.test(value)) {
      return 'amount must be a canonical non-negative decimal without exponent, sign, leading zero, or trailing fractional zero';
    }
    const [integer = '', fraction = ''] = value.split('.');
    return integer.length <= PURCHASE_LIMIT_DECIMAL_INTEGER_DIGITS && fraction.length <= PURCHASE_LIMIT_DECIMAL_SCALE
      ? undefined
      : `amount must fit numeric(${PURCHASE_LIMIT_DECIMAL_PRECISION}, ${PURCHASE_LIMIT_DECIMAL_SCALE}): at most ${PURCHASE_LIMIT_DECIMAL_INTEGER_DIGITS} integer digits and ${PURCHASE_LIMIT_DECIMAL_SCALE} fractional digits`;
  }),
).pipe(Schema.brand('ExactNonNegativeDecimal'));
export type ExactNonNegativeDecimal = typeof ExactNonNegativeDecimalSchema.Type;

const PurchaseLimitCurrencyCodeSchema = CurrencyCodeSchema;

export const MonetaryAmountSchema = Schema.Struct({
  amount: ExactNonNegativeDecimalSchema,
  currency: PurchaseLimitCurrencyCodeSchema,
});
export type MonetaryAmount = typeof MonetaryAmountSchema.Type;

export const PurchaseValueSchema = Schema.Struct({
  monetaryAmount: MonetaryAmountSchema,
  roundingRuleRevision: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  sourceRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  sourceRevision: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export type PurchaseValue = typeof PurchaseValueSchema.Type;

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

const decimalParts = (value: ExactNonNegativeDecimal): DecimalParts => {
  const [integer = '0', fraction = ''] = value.split('.');
  return {
    coefficient: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  };
};

/** Compares two already-decoded exact decimal amounts without binary floating point. */
export const compareExactDecimals = (left: ExactNonNegativeDecimal, right: ExactNonNegativeDecimal): -1 | 0 | 1 => {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const scaledLeft = leftParts.coefficient * 10n ** BigInt(scale - leftParts.scale);
  const scaledRight = rightParts.coefficient * 10n ** BigInt(scale - rightParts.scale);
  if (scaledLeft < scaledRight) {
    return -1;
  }
  if (scaledLeft > scaledRight) {
    return 1;
  }
  return 0;
};
