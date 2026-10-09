import { Schema } from 'effect';

export class InventoryReconciliationEvidenceUnavailable extends Schema.TaggedError<InventoryReconciliationEvidenceUnavailable>()(
  'InventoryReconciliationEvidenceUnavailable',
  {
    code: Schema.Literal('inventory_reconciliation_evidence_unavailable'),
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}
