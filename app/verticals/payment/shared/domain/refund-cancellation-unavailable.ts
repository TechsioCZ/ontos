import { Schema } from 'effect';

/** Payment-owned state could not be read or written for a cancellation; never absence or success. */
export class PaymentCancellationUnavailable extends Schema.TaggedError<PaymentCancellationUnavailable>()(
  'PaymentCancellationUnavailable',
  {
    code: Schema.Literal('payment_unavailable'),
    reason: Schema.String,
  },
) {}

export const paymentCancellationUnavailable = (reason: string): PaymentCancellationUnavailable =>
  new PaymentCancellationUnavailable({ code: 'payment_unavailable', reason });
