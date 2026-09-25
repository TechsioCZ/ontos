import { Schema } from 'effect';

export class InventoryPostCommitReconciliationUnavailable extends Schema.TaggedError<InventoryPostCommitReconciliationUnavailable>()(
  'InventoryPostCommitReconciliationUnavailable',
  {
    code: Schema.Literal('inventory_post_commit_reconciliation_unavailable'),
    reason: Schema.String,
  },
) {}
