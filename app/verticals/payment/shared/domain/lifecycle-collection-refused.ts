import { Schema } from 'effect';

/** COLLECT start refusals (#1148 money invariants, #1151 original-binding recovery). */
export const PAYMENT_COLLECTION_REFUSAL_CODES = [
  /** A zero payable purchase never gets a fictitious COLLECT. */
  'payment_zero_payable_no_collection',
  /** The original gateway binding is no longer Currently enabled; there is no failover. */
  'payment_binding_not_enabled',
] as const;
export const PaymentCollectionRefusalCodeSchema = Schema.Literals(PAYMENT_COLLECTION_REFUSAL_CODES);
export type PaymentCollectionRefusalCode = typeof PaymentCollectionRefusalCodeSchema.Type;

export class PaymentCollectionRefused extends Schema.TaggedError<PaymentCollectionRefused>()(
  'PaymentCollectionRefused',
  {
    code: PaymentCollectionRefusalCodeSchema,
    reason: Schema.String,
  },
) {}

export const paymentCollectionRefused = (
  code: PaymentCollectionRefusalCode,
  reason: string,
): PaymentCollectionRefused => new PaymentCollectionRefused({ code, reason });
