import { Schema } from 'effect';

/** The refund conflicts with the Current Payment aggregate, a live reservation or the funds guard (#1150). */
export const PAYMENT_REFUND_CONFLICT_CODES = [
  'payment_operation_material_conflict',
  'payment_refund_item_reserved',
  'payment_refund_item_refunded',
  'payment_refundable_funds_exceeded',
  'payment_held_for_reconciliation',
  'payment_aggregate_version_conflict',
  /** More than one configured refund executor qualifies; configuration never selects by order. */
  'payment_refund_route_conflict',
] as const;
export const PaymentRefundConflictCodeSchema = Schema.Literals(PAYMENT_REFUND_CONFLICT_CODES);
export type PaymentRefundConflictCode = typeof PaymentRefundConflictCodeSchema.Type;

export class PaymentRefundConflict extends Schema.TaggedError<PaymentRefundConflict>()('PaymentRefundConflict', {
  code: PaymentRefundConflictCodeSchema,
  reason: Schema.String,
}) {}

export const paymentRefundConflict = (code: PaymentRefundConflictCode, reason: string): PaymentRefundConflict =>
  new PaymentRefundConflict({ code, reason });
