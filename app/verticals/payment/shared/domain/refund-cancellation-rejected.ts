import { Schema } from 'effect';

/** The cancellation request itself is not acceptable for its target collection (#1150). */
export const PAYMENT_CANCELLATION_REJECTION_CODES = [
  'payment_not_found',
  'payment_operation_not_found',
  /** Only a COLLECT of the same Payment can be cancelled or voided. */
  'payment_cancellation_target_invalid',
  /** Collection is already proven: returning the funds needs a REFUND on an accepted basis. */
  'payment_cancellation_after_collection',
  /** The collection is definitively not effected; nothing is left to stop. */
  'payment_cancellation_target_not_live',
] as const;
export const PaymentCancellationRejectionCodeSchema = Schema.Literals(PAYMENT_CANCELLATION_REJECTION_CODES);
export type PaymentCancellationRejectionCode = typeof PaymentCancellationRejectionCodeSchema.Type;

export class PaymentCancellationRejected extends Schema.TaggedError<PaymentCancellationRejected>()(
  'PaymentCancellationRejected',
  {
    code: PaymentCancellationRejectionCodeSchema,
    reason: Schema.String,
  },
) {}

export const paymentCancellationRejected = (
  code: PaymentCancellationRejectionCode,
  reason: string,
): PaymentCancellationRejected => new PaymentCancellationRejected({ code, reason });
