import { Schema } from 'effect';

export class InventorySourceConflictUnavailable extends Schema.TaggedError<InventorySourceConflictUnavailable>()(
  'InventorySourceConflictUnavailable',
  {
    code: Schema.Literal('inventory_source_conflict_unavailable'),
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}
