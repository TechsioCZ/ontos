import { Schema } from 'effect';
import type { Option } from 'effect';

import { PaymentAmountMinorSchema, PaymentMonetaryAmountSchema } from '../../../shared/domain/payment-money.ts';
import type { PaymentMonetaryAmount } from '../../../shared/domain/payment-money.ts';
import { PaymentSourceClaimedAmountSchema } from '../../../shared/domain/source-statement.ts';

/**
 * Exact provider money handling (#1156). Payment expects CZK integer minor units (haléře) at Launch;
 * a provider may still report another currency, and that authentic amount is kept as evidence of a
 * different monetary effect. Nothing here rounds, scales, converts currencies or accepts a float.
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

/**
 * A provider-reported amount: exact integer minor units and the provider's own upper-case ISO 4217
 * code, in any currency (the C16 A8 claimed amount). Providers that report lower-case codes (Stripe
 * `czk`) upper-case them in their own wire mapping before decoding.
 */
export const ProviderReportedAmountSchema = PaymentSourceClaimedAmountSchema;
export type ProviderReportedAmount = typeof ProviderReportedAmountSchema.Type;

/** Admits only CZK integer minor units in the safe range; any other currency is `None`. */
export const assertLaunchMinor = (amount: ProviderReportedAmount): Option.Option<PaymentMonetaryAmount> =>
  Schema.decodeUnknownOption(PaymentMonetaryAmountSchema)(amount);

/** The amount Payment expected next to the authentic amount the provider reported, in its own currency. */
export const ProviderAmountDiscrepancySchema = Schema.Struct({
  expected: PaymentMonetaryAmountSchema,
  observed: ProviderReportedAmountSchema,
});
export type ProviderAmountDiscrepancy = typeof ProviderAmountDiscrepancySchema.Type;

export const ObservedAmountComparisonSchema = Schema.Union([
  Schema.TaggedStruct('MATCH', {}),
  Schema.TaggedStruct('MISMATCH', { discrepancy: ProviderAmountDiscrepancySchema }),
]);
export type ObservedAmountComparison = typeof ObservedAmountComparisonSchema.Type;

/**
 * A mismatch of amount or currency is a discrepancy for verification, never a confirmation of either
 * amount (#1156): callers map MISMATCH to VERIFICATION_CONFLICT with the discrepancy attached.
 */
export const compareObservedAmount = (
  expected: PaymentMonetaryAmount,
  observed: ProviderReportedAmount,
): ObservedAmountComparison =>
  expected.amountMinor === observed.amountMinor && expected.currency === observed.currency
    ? { _tag: 'MATCH' }
    : { _tag: 'MISMATCH', discrepancy: { expected, observed } };
