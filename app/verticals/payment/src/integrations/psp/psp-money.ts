import { Schema } from 'effect';
import type { Option } from 'effect';

import { PaymentAmountMinorSchema, PaymentMonetaryAmountSchema } from '../../../shared/domain/payment-money.ts';
import type { PaymentMonetaryAmount } from '../../../shared/domain/payment-money.ts';

/**
 * Exact provider money handling (#1156). All three Launch providers report CZK in integer minor
 * units (haléře). Nothing here rounds, scales, converts currencies or accepts a float.
 */

/**
 * An unsigned base-10 integer: no sign, no exponent, no fraction, no whitespace, no leading zero.
 * The value must stay inside the safe int53 range of `PaymentAmountMinorSchema`.
 */
const ExactMinorUnitsTextSchema = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]{0,15})$/u)).pipe(
  Schema.decodeTo(Schema.FiniteFromString.pipe(Schema.decodeTo(PaymentAmountMinorSchema))),
);

/** Parses a provider amount text such as Comgate `price: "159950"`; anything else is `None`. */
export const parseExactMinorUnits = (text: string): Option.Option<number> =>
  Schema.decodeUnknownOption(ExactMinorUnitsTextSchema)(text);

/** A provider-reported amount before it is admitted as Launch money. Currency is compared exactly. */
export interface ProviderReportedAmount {
  readonly amountMinor: number;
  readonly currency: string;
}

/**
 * Admits only CZK integer minor units in the safe range. Providers that report lower-case
 * currency codes (Stripe `czk`) upper-case them in their own wire mapping before calling this.
 */
export const assertLaunchMinor = (amount: ProviderReportedAmount): Option.Option<PaymentMonetaryAmount> =>
  Schema.decodeUnknownOption(PaymentMonetaryAmountSchema)(amount);

/** The amount Payment expected next to the amount the provider reported. */
export const ProviderAmountDiscrepancySchema = Schema.Struct({
  expected: PaymentMonetaryAmountSchema,
  observed: PaymentMonetaryAmountSchema,
});
export type ProviderAmountDiscrepancy = typeof ProviderAmountDiscrepancySchema.Type;

export const ObservedAmountComparisonSchema = Schema.Union([
  Schema.TaggedStruct('MATCH', {}),
  Schema.TaggedStruct('MISMATCH', { discrepancy: ProviderAmountDiscrepancySchema }),
]);
export type ObservedAmountComparison = typeof ObservedAmountComparisonSchema.Type;

/**
 * A mismatch is a discrepancy for verification, never a confirmation of either amount (#1156):
 * callers map MISMATCH to VERIFICATION_CONFLICT with the discrepancy attached.
 */
export const compareObservedAmount = (
  expected: PaymentMonetaryAmount,
  observed: PaymentMonetaryAmount,
): ObservedAmountComparison =>
  expected.amountMinor === observed.amountMinor && expected.currency === observed.currency
    ? { _tag: 'MATCH' }
    : { _tag: 'MISMATCH', discrepancy: { expected, observed } };
