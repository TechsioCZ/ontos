import type { AccessAmount } from '@app/core-runtime';
import { Data } from 'effect';

import type { MonetaryAmount } from '../../shared/domain/purchase-limit.ts';

/**
 * The governed amount of a Purchase Value command (O18, R5b-6).
 *
 * A purchase value is composite money: the declaration may never name a bare `amount` component as
 * the authoritative total, so it names the server-derived total (`derived.purchaseValue`) and this
 * resolver returns exactly one scalar `{minor, currency}` for the gate's ceiling caveat.
 *
 * The amount is the owner-verified purchase value the command carries, converted to the currency's
 * minor units with the platform's own currency data (the same source Pricing uses). A value that is
 * not representable in minor units is rounded up, never down, so the governed amount can never
 * understate the purchase and slip beneath a ceiling.
 */

/** Internal defect of the amount derivation: the runner answers it as an unavailable permission check. */
export class PurchaseValueAmountUnresolvable extends Data.TaggedError('PurchaseValueAmountUnresolvable')<{
  readonly reason: string;
}> {}

/** The platform's own ISO 4217 currency set, the same source Pricing recognizes a code from. */
const RECOGNIZED_CURRENCY_CODES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));

/**
 * The number of minor-unit digits of one currency, read from the platform currency data (CLDR/ICU):
 * CZK/EUR/USD 2, JPY 0, BHD/KWD 3. The table is derived, never hand-written; a code the platform
 * does not recognize is refused rather than assumed to have two digits.
 */
const minorUnitDigits = (currency: string): bigint => {
  if (!RECOGNIZED_CURRENCY_CODES.has(currency)) {
    throw new PurchaseValueAmountUnresolvable({
      reason: `The purchase-value currency ${currency} is not a recognized ISO 4217 currency code`,
    });
  }
  const { maximumFractionDigits } = new Intl.NumberFormat('en', { currency, style: 'currency' }).resolvedOptions();
  if (maximumFractionDigits === undefined) {
    throw new PurchaseValueAmountUnresolvable({
      reason: `The purchase-value currency ${currency} has no platform minor unit`,
    });
  }
  return BigInt(maximumFractionDigits);
};

/** The exact decimal the owner's own schema already validated: `[integer, fraction]`, no sign. */
const decimalParts = (value: MonetaryAmount['amount']) => {
  const [integer = '0', fraction = ''] = value.split('.');
  return { coefficient: BigInt(`${integer}${fraction}`), scale: BigInt(fraction.length) };
};

/** Exact minor units when representable; rounded up (never down) when the decimal carries more digits. */
const toMinorUnits = (value: MonetaryAmount['amount'], digits: bigint, currency: string): number => {
  const { coefficient, scale } = decimalParts(value);
  const minor =
    scale >= digits
      ? coefficient / 10n ** (scale - digits) + (coefficient % 10n ** (scale - digits) === 0n ? 0n : 1n)
      : coefficient * 10n ** (digits - scale);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PurchaseValueAmountUnresolvable({
      reason: `The purchase value is outside the ${currency} range`,
    });
  }
  return Number(minor);
};

/**
 * One scalar `{minor, currency}` for a Purchase Value's own monetary amount. The value is exact
 * wherever the money is; a value with more fractional digits than the currency's minor unit is
 * rounded up so the governed amount never understates the purchase.
 */
export const purchaseValueAccessAmount = (monetaryAmount: MonetaryAmount): AccessAmount => ({
  currency: monetaryAmount.currency,
  minor: toMinorUnits(monetaryAmount.amount, minorUnitDigits(monetaryAmount.currency), monetaryAmount.currency),
});
