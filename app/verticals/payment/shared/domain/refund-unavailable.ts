import { Schema } from 'effect';

/** Required evidence or the required execution route is unavailable: never absence or a fallback (#1150). */
export const PAYMENT_REFUND_UNAVAILABLE_CODES = [
  'payment_unavailable',
  'payment_owner_evidence_unavailable',
  'payment_refund_route_unavailable',
] as const;
export const PaymentRefundUnavailableCodeSchema = Schema.Literals(PAYMENT_REFUND_UNAVAILABLE_CODES);
export type PaymentRefundUnavailableCode = typeof PaymentRefundUnavailableCodeSchema.Type;

export class PaymentRefundUnavailable extends Schema.TaggedError<PaymentRefundUnavailable>()(
  'PaymentRefundUnavailable',
  {
    code: PaymentRefundUnavailableCodeSchema,
    reason: Schema.String,
  },
) {}

export const paymentRefundUnavailable = (
  code: PaymentRefundUnavailableCode,
  reason: string,
): PaymentRefundUnavailable => new PaymentRefundUnavailable({ code, reason });
