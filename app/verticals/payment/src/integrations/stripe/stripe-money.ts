import { Schema } from 'effect';
import type { Option } from 'effect';

import type { PaymentPositiveMonetaryAmountSchema } from '../../../shared/domain/payment-money.ts';
import { ProviderReportedAmountSchema } from '../psp/psp-money.ts';
import type { ProviderReportedAmount } from '../psp/psp-money.ts';

/**
 * Stripe money (#1156): `unit_amount`/`amount` are integers in the smallest currency unit and `currency`
 * is the lower-case ISO code (https://docs.stripe.com/currencies). CZK is a two-decimal currency at
 * Stripe, so 1 599,50 CZK is `unit_amount=159950&currency=czk`. Nothing here rounds, scales or converts.
 */

type PaymentPositiveMonetaryAmount = typeof PaymentPositiveMonetaryAmountSchema.Type;

const STRIPE_CURRENCY_CODES = { CZK: 'czk' } as const satisfies Record<
  PaymentPositiveMonetaryAmount['currency'],
  string
>;

export interface StripeFormAmount {
  readonly currency: (typeof STRIPE_CURRENCY_CODES)[keyof typeof STRIPE_CURRENCY_CODES];
  /** Base-10 integer text of the minor units, ready for a form-encoded body. */
  readonly minorUnits: string;
}

/** The Launch amount as Stripe form fields. The amount is already a validated positive safe integer. */
export const toStripeFormAmount = (amount: PaymentPositiveMonetaryAmount): StripeFormAmount => ({
  currency: STRIPE_CURRENCY_CODES[amount.currency],
  minorUnits: amount.amountMinor.toFixed(0),
});

/**
 * The authentic amount a Stripe object reports, with its currency upper-cased first. Any ISO currency is
 * kept (EUR stays EUR and later compares as a mismatch); `None` only for a value that is not exact money.
 */
export const fromStripeAmount = (amountMinor: number, currency: string): Option.Option<ProviderReportedAmount> =>
  Schema.decodeUnknownOption(ProviderReportedAmountSchema)({ amountMinor, currency: currency.toUpperCase() });
