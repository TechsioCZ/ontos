import { Schema } from 'effect';

/** Request or business-rule refusal: the request itself is not acceptable for this Payment. */
export const PAYMENT_REJECTION_CODES = [
  'payment_not_found',
  'payment_operation_not_found',
  'payment_amount_invalid',
  'payment_currency_mismatch',
  'payment_method_binding_mismatch',
  'payment_outcome_transition_illegal',
  'payment_refund_basis_invalid',
  'payment_refund_item_fractioned',
  'payment_refund_amount_mismatch',
  'payment_no_established_collection',
] as const;
export const PaymentRejectionCodeSchema = Schema.Literals(PAYMENT_REJECTION_CODES);
export type PaymentRejectionCode = typeof PaymentRejectionCodeSchema.Type;

export class PaymentRejected extends Schema.TaggedError<PaymentRejected>()('PaymentRejected', {
  code: PaymentRejectionCodeSchema,
  reason: Schema.String,
}) {}

export const paymentRejected = (code: PaymentRejectionCode, reason: string): PaymentRejected =>
  new PaymentRejected({ code, reason });
