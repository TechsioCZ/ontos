import type { AccessAmount } from '@app/core-runtime';
import { Data } from 'effect';
import type { PrepareOrderCommitmentInput } from '../../shared/domain/order-commitment.ts';

/**
 * The governed amount of an Order commitment command (O18).
 *
 * A purchase value is composite money: Pricing publishes one net commercial value per demand
 * occurrence, and CCC's proposal states their sum as `purchaseValue.monetaryAmount`. The gate may
 * never take a caller-supplied total, so the owner derives the total from the frozen candidate the
 * command carries — the exact published net line values of the final purchase — and the handler
 * re-verifies that same candidate against Pricing and the CCC proposal before anything is written.
 *
 * The derivation is exact wherever the money is: published line values are exact rationals, so their
 * sum is exact too. A sum that is not representable in the currency's minor units is rounded up,
 * never down, so the governed amount can never understate the purchase and slip beneath a ceiling.
 * A candidate with no published Pricing line states no purchase value; the owner's own candidate
 * verification refuses it, so that refusal stays the domain's answer.
 */

/** Internal defect of the amount derivation: the runner answers it as an unavailable permission check. */
export class OrderPurchaseValueUnresolvable extends Data.TaggedError('OrderPurchaseValueUnresolvable')<{
  readonly reason: string;
}> {}

/**
 * The platform's own ISO 4217 currency set: the same source Pricing uses to recognize a code
 * (`Intl.supportedValuesOf('currency')`). A currency outside it has no minor unit the owner can
 * trust, so the derivation refuses it instead of guessing an exponent.
 */
const RECOGNIZED_CURRENCY_CODES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));

/**
 * Minor units per major unit of one currency, read from the platform currency data (CLDR/ICU) the
 * same way the recognized code set is. CZK/EUR/USD stay at 100, JPY at 1, BHD/KWD at 1000 and so on.
 * The table is derived, never hand-written, so a currency with a different exponent needs no new
 * entry; a code the platform does not recognize is refused rather than assumed to have two digits.
 */
const minorUnitsPerMajor = (currency: string): bigint => {
  if (!RECOGNIZED_CURRENCY_CODES.has(currency)) {
    throw new OrderPurchaseValueUnresolvable({
      reason: `The published currency ${currency} is not a recognized ISO 4217 currency code`,
    });
  }
  const { maximumFractionDigits } = new Intl.NumberFormat('en', { currency, style: 'currency' }).resolvedOptions();
  if (maximumFractionDigits === undefined) {
    throw new OrderPurchaseValueUnresolvable({
      reason: `The published currency ${currency} has no platform minor unit`,
    });
  }
  return 10n ** BigInt(maximumFractionDigits);
};

type ExactRational = Readonly<{ readonly denominator: string; readonly numerator: string }>;

const absolute = (value: bigint): bigint => (value < 0n ? -value : value);
const greatestCommonDivisor = (left: bigint, right: bigint): bigint => {
  let first = absolute(left);
  let second = absolute(right);
  while (second !== 0n) {
    const remainder = first % second;
    first = second;
    second = remainder;
  }
  return first;
};

/** Exact sum in lowest terms; no approximation ever enters the governed amount. */
const sumExactRationals = (values: readonly [ExactRational, ...ExactRational[]]): ExactRational => {
  let numerator = 0n;
  let denominator = 1n;
  for (const value of values) {
    numerator = numerator * BigInt(value.denominator) + BigInt(value.numerator) * denominator;
    denominator *= BigInt(value.denominator);
    const divisor = greatestCommonDivisor(numerator, denominator);
    numerator /= divisor;
    denominator /= divisor;
  }
  return { denominator: denominator.toString(), numerator: numerator.toString() };
};

const ceilingMinorUnits = (value: ExactRational, scale: bigint, currency: string): number => {
  const numerator = BigInt(value.numerator) * scale;
  const denominator = BigInt(value.denominator);
  if (numerator < 0n) {
    throw new OrderPurchaseValueUnresolvable({ reason: 'The published net purchase value is negative' });
  }
  const minor = numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new OrderPurchaseValueUnresolvable({
      reason: `The published net purchase value is outside the ${currency} range`,
    });
  }
  return Number(minor);
};

/**
 * The net purchase value of exactly this frozen candidate: the sum of the published net commercial
 * line values, in the single currency Pricing published them in.
 */
export const purchaseValueAccessAmount = (candidate: PrepareOrderCommitmentInput['taxCandidate']): AccessAmount => {
  const { publishedLines } = candidate.pricing;
  const [first, ...rest] = publishedLines;
  if (first === undefined) {
    return { currency: candidate.purchase.currency, minor: 0 };
  }
  const { currency } = first.lineCommercialValue;
  const singleCurrency = publishedLines.every((line) => line.lineCommercialValue.currency === currency);
  const singleBasis = publishedLines.every((line) => line.lineCommercialValue.amountBasis === 'NET');
  if (!singleCurrency || !singleBasis) {
    throw new OrderPurchaseValueUnresolvable({
      reason: 'The published Pricing lines do not state one net purchase value in one currency',
    });
  }
  const scale = minorUnitsPerMajor(currency);
  const amounts: readonly [ExactRational, ...ExactRational[]] = [
    first.lineCommercialValue.amount,
    ...rest.map((line) => line.lineCommercialValue.amount),
  ];
  return { currency, minor: ceilingMinorUnits(sumExactRationals(amounts), scale, currency) };
};

/** The exact rational of one canonical non-negative decimal, e.g. `12.5` -> 125/10. */
const decimalToExactRational = (amount: string): ExactRational => {
  const [integer = '0', fraction = ''] = amount.split('.');
  return { denominator: (10n ** BigInt(fraction.length)).toString(), numerator: `${integer}${fraction}` };
};

/**
 * The governed amount of an owner-verified frozen purchase value (O91, O18).
 *
 * The commit command carries the exact purchase value the owner froze at preparation, and the gate
 * reads its single `monetaryAmount` as the amount an amount ceiling applies to. The value is not
 * authoritative on its own: the commit handler re-checks it against the stored Bundle in the same
 * transaction before anything is written, so a forged or stale value is refused, never admitted
 * (O91). The conversion is exact and rounds up, exactly as the candidate derivation does, so the
 * governed amount can never understate the purchase and slip beneath a ceiling.
 */
export const frozenPurchaseValueAccessAmount = (purchaseValue: {
  readonly monetaryAmount: { readonly amount: string; readonly currency: string };
}): AccessAmount => {
  const { amount, currency } = purchaseValue.monetaryAmount;
  const scale = minorUnitsPerMajor(currency);
  return { currency, minor: ceilingMinorUnits(decimalToExactRational(amount), scale, currency) };
};
