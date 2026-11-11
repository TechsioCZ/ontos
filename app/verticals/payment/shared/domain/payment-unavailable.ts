import { Schema } from 'effect';

/** Payment-owned state could not be read or written; never interpreted as absence or success. */
export class PaymentUnavailable extends Schema.TaggedError<PaymentUnavailable>()('PaymentUnavailable', {
  code: Schema.Literal('payment_unavailable'),
  reason: Schema.String,
}) {}

/** The driver cause travels as the non-enumerable native `cause`, never in the public payload. */
export const paymentUnavailable = (reason: string, cause?: unknown): PaymentUnavailable => {
  const failure = new PaymentUnavailable({ code: 'payment_unavailable', reason });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};
