import { Schema } from 'effect';

/** The refund request itself is not acceptable for this Payment (#1150). */
export const PAYMENT_REFUND_REJECTION_CODES = [
  'payment_not_found',
  'payment_amount_invalid',
  'payment_currency_mismatch',
  /** No refund before proven collection. */
  'payment_no_established_collection',
  'payment_refund_basis_invalid',
  /** The requested amount is not the exact sum of the complete selected items. */
  'payment_refund_item_fractioned',
  /** A supplied item differs from the authoritative refundable item of its owner. */
  'payment_refund_item_mismatch',
  'payment_refund_item_not_refundable',
  /** Compensation must return exactly the remaining unrefunded collected amount. */
  'payment_refund_amount_mismatch',
  /** Authoritative terminal non-commit plus closure against late commit is not established. */
  'payment_compensation_not_established',
] as const;
export const PaymentRefundRejectionCodeSchema = Schema.Literals(PAYMENT_REFUND_REJECTION_CODES);
export type PaymentRefundRejectionCode = typeof PaymentRefundRejectionCodeSchema.Type;

export class PaymentRefundRejected extends Schema.TaggedError<PaymentRefundRejected>()('PaymentRefundRejected', {
  code: PaymentRefundRejectionCodeSchema,
  reason: Schema.String,
}) {}

export const paymentRefundRejected = (code: PaymentRefundRejectionCode, reason: string): PaymentRefundRejected =>
  new PaymentRefundRejected({ code, reason });
