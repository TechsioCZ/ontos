import type { AccessAmount } from '@app/core-runtime';
import { Data } from 'effect';

/**
 * Internal defect of a governed-amount derivation: the runner answers it as an unavailable
 * permission check, never as an allow (CUTOVER-PLAN §3.1 step 5, O18).
 */
export class PricingAccessAmountUnresolvable extends Data.TaggedError('PricingAccessAmountUnresolvable')<{
  readonly reason: string;
}> {}

const MINOR_UNIT_DIGITS = 2;

/**
 * The governed amount of one configured Pricing money value (O18).
 *
 * Pricing states money as a canonical non-negative decimal (up to nine fraction digits) in one
 * currency. The gate may never take a caller-supplied total, so the owner derives the exact minor
 * unit count here: whole minor units are added and any remaining fraction rounds up, never down, so
 * the governed amount can never understate the configured value and slip beneath a ceiling. Pricing
 * publishes amounts at the two-digit minor scale of the currencies it supports today; a currency
 * with a different exponent would need its own scale in this derivation.
 */
export const pricingAccessAmount = (money: {
  readonly amount: string;
  readonly currencyCode: string;
}): AccessAmount => {
  const [integer = '', fraction = ''] = money.amount.split('.');
  const padded = fraction.padEnd(MINOR_UNIT_DIGITS + 1, '0');
  const minorPart = padded.slice(0, MINOR_UNIT_DIGITS);
  const roundsUp = /[1-9]/u.test(padded.slice(MINOR_UNIT_DIGITS));
  const minor = BigInt(integer) * 100n + BigInt(minorPart) + (roundsUp ? 1n : 0n);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PricingAccessAmountUnresolvable({
      reason: `The configured amount is outside the ${money.currencyCode} range`,
    });
  }
  return { currency: money.currencyCode, minor: Number(minor) };
};
