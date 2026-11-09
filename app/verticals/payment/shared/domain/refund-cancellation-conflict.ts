import { Schema } from 'effect';

/** The cancellation conflicts with the Current Payment aggregate (#1150). */
export const PAYMENT_CANCELLATION_CONFLICT_CODES = [
  'payment_operation_material_conflict',
  /** A cancellation of the same collection is still live or unknown; no second request escapes it. */
  'payment_cancellation_in_progress',
  'payment_held_for_reconciliation',
  'payment_aggregate_version_conflict',
] as const;
export const PaymentCancellationConflictCodeSchema = Schema.Literals(PAYMENT_CANCELLATION_CONFLICT_CODES);
export type PaymentCancellationConflictCode = typeof PaymentCancellationConflictCodeSchema.Type;

export class PaymentCancellationConflict extends Schema.TaggedError<PaymentCancellationConflict>()(
  'PaymentCancellationConflict',
  {
    code: PaymentCancellationConflictCodeSchema,
    reason: Schema.String,
  },
) {}

export const paymentCancellationConflict = (
  code: PaymentCancellationConflictCode,
  reason: string,
): PaymentCancellationConflict => new PaymentCancellationConflict({ code, reason });
