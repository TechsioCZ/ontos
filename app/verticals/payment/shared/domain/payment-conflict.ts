import { Schema } from 'effect';

/** Concurrency, idempotency or funds-guard conflict against the Current Payment aggregate. */
export const PAYMENT_CONFLICT_CODES = [
  'payment_identity_conflict',
  'payment_intent_material_conflict',
  'payment_collect_lineage_conflict',
  'payment_operation_material_conflict',
  'payment_refund_item_reserved',
  'payment_refundable_funds_exceeded',
  'payment_aggregate_version_conflict',
  'payment_held_for_reconciliation',
] as const;
export const PaymentConflictCodeSchema = Schema.Literals(PAYMENT_CONFLICT_CODES);
export type PaymentConflictCode = typeof PaymentConflictCodeSchema.Type;

export class PaymentConflict extends Schema.TaggedError<PaymentConflict>()('PaymentConflict', {
  code: PaymentConflictCodeSchema,
  reason: Schema.String,
}) {}

export const paymentConflict = (code: PaymentConflictCode, reason: string): PaymentConflict =>
  new PaymentConflict({ code, reason });
