import { Result } from 'effect';

import { PAYMENT_LAUNCH_CURRENCY, PAYMENT_MAXIMUM_AMOUNT_MINOR } from '../../shared/domain/payment-money.ts';
import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import { paymentRejected } from '../../shared/domain/payment-rejected.ts';
import type { PaymentRejected } from '../../shared/domain/payment-rejected.ts';

/**
 * Exact integer minor-unit arithmetic for one currency (#1148). No floats, FX or rounding: a
 * currency mismatch or an amount outside the safe int53 range is a typed refusal, never coerced.
 */
export const zeroAmount: PaymentMonetaryAmount = Object.freeze({ amountMinor: 0, currency: PAYMENT_LAUNCH_CURRENCY });

export const sameCurrency = (left: PaymentMonetaryAmount, right: PaymentMonetaryAmount): boolean =>
  left.currency === right.currency;

export const sameAmount = (left: PaymentMonetaryAmount, right: PaymentMonetaryAmount): boolean =>
  sameCurrency(left, right) && left.amountMinor === right.amountMinor;

export const isZeroAmount = (amount: PaymentMonetaryAmount): boolean => amount.amountMinor === 0;

const currencyMismatch = () => paymentRejected('payment_currency_mismatch', 'Amounts are in different currencies');

const checkedAmount = (
  amountMinor: number,
  currency: PaymentMonetaryAmount['currency'],
): Result.Result<PaymentMonetaryAmount, PaymentRejected> =>
  Number.isSafeInteger(amountMinor) && amountMinor >= 0 && amountMinor <= PAYMENT_MAXIMUM_AMOUNT_MINOR
    ? Result.succeed({ amountMinor, currency })
    : Result.fail(paymentRejected('payment_amount_invalid', 'The amount is outside the exact minor-unit range'));

export const addAmounts = (
  left: PaymentMonetaryAmount,
  right: PaymentMonetaryAmount,
): Result.Result<PaymentMonetaryAmount, PaymentRejected> =>
  sameCurrency(left, right)
    ? checkedAmount(left.amountMinor + right.amountMinor, left.currency)
    : Result.fail(currencyMismatch());

/** A negative difference is refused: Payment never represents money below zero. */
export const subtractAmounts = (
  left: PaymentMonetaryAmount,
  right: PaymentMonetaryAmount,
): Result.Result<PaymentMonetaryAmount, PaymentRejected> =>
  sameCurrency(left, right)
    ? checkedAmount(left.amountMinor - right.amountMinor, left.currency)
    : Result.fail(currencyMismatch());

/** Exact sum of amounts in the expected currency; an empty list sums to zero. */
export const sumAmounts = (
  amounts: readonly PaymentMonetaryAmount[],
  currency: PaymentMonetaryAmount['currency'] = PAYMENT_LAUNCH_CURRENCY,
): Result.Result<PaymentMonetaryAmount, PaymentRejected> => {
  let amountMinor = 0;
  for (const amount of amounts) {
    if (amount.currency !== currency) {
      return Result.fail(currencyMismatch());
    }
    amountMinor += amount.amountMinor;
  }
  return checkedAmount(amountMinor, currency);
};

/** -1, 0 or 1; a currency mismatch is refused rather than ordered. */
export const compareAmounts = (
  left: PaymentMonetaryAmount,
  right: PaymentMonetaryAmount,
): Result.Result<-1 | 0 | 1, PaymentRejected> => {
  if (!sameCurrency(left, right)) {
    return Result.fail(currencyMismatch());
  }
  if (left.amountMinor === right.amountMinor) {
    return Result.succeed(0);
  }
  return Result.succeed(left.amountMinor < right.amountMinor ? -1 : 1);
};
