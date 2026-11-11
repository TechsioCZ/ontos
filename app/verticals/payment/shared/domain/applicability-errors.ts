import { Schema } from 'effect';

/**
 * The caller decided against a different Current method enablement revision than the one stored
 * (stale write). Nothing was changed; re-read and decide again.
 */
export class PaymentMethodEnablementConflict extends Schema.TaggedError<PaymentMethodEnablementConflict>()(
  'PaymentMethodEnablementConflict',
  {
    code: Schema.Literal('payment_method_enablement_revision_conflict'),
    reason: Schema.String,
  },
) {}

export const paymentMethodEnablementConflict = (reason: string): PaymentMethodEnablementConflict =>
  new PaymentMethodEnablementConflict({ code: 'payment_method_enablement_revision_conflict', reason });
