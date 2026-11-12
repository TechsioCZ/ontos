import type { PaymentMonetaryAmount } from '../../../shared/domain/payment-money.ts';
import type { ProviderReportedAmount } from '../psp/psp-money.ts';

/**
 * GoPay money (#1156). GoPay `amount` is "Total amount in cents": the integer CZK minor units
 * (haléře) Payment already holds, so the value passes through unchanged. Nothing rounds, scales or
 * converts; the currency is always sent as `CZK` and the reported currency is kept as reported.
 */

export interface GopayAmount {
  readonly amount: number;
  readonly currency: 'CZK';
}

/** Request amount of a create or refund: exactly the Payment amount in minor units. */
export const toGopayAmount = (amount: PaymentMonetaryAmount): GopayAmount => ({
  amount: amount.amountMinor,
  currency: amount.currency,
});

/**
 * The authentic amount a decoded GoPay response reports. The wire schema already admits only exact
 * safe integers and upper-case ISO codes, so another currency (e.g. EUR) is kept, never dropped.
 */
export const fromGopayAmount = (reported: {
  readonly amount: number;
  readonly currency: string;
}): ProviderReportedAmount => ({ amountMinor: reported.amount, currency: reported.currency });
