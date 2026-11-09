import { Schema } from 'effect';

/** Intent-lineage conflicts owned by the lifecycle lane (#1148 cardinality and lineage). */
export const PAYMENT_LIFECYCLE_CONFLICT_CODES = [
  /** The predecessor still has a live, indeterminate or conflicting effect, held evidence or unreturned funds. */
  'payment_predecessor_unresolved_conflict',
  /** The predecessor already has a successor intent; a second successor would compete with it. */
  'payment_predecessor_superseded_conflict',
  /** A superseded Payment cannot start a new collection; its successor carries the purchase meaning. */
  'payment_superseded_conflict',
  /** The requested collection meaning differs from the immutable Payment meaning. */
  'payment_collection_meaning_conflict',
] as const;
export const PaymentLifecycleConflictCodeSchema = Schema.Literals(PAYMENT_LIFECYCLE_CONFLICT_CODES);
export type PaymentLifecycleConflictCode = typeof PaymentLifecycleConflictCodeSchema.Type;

export class PaymentLifecycleConflict extends Schema.TaggedError<PaymentLifecycleConflict>()(
  'PaymentLifecycleConflict',
  {
    code: PaymentLifecycleConflictCodeSchema,
    reason: Schema.String,
  },
) {}

export const paymentLifecycleConflict = (
  code: PaymentLifecycleConflictCode,
  reason: string,
): PaymentLifecycleConflict => new PaymentLifecycleConflict({ code, reason });
