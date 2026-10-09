import { Schema } from 'effect';

export class InventoryReconciliationEvidenceRejected extends Schema.TaggedError<InventoryReconciliationEvidenceRejected>()(
  'InventoryReconciliationEvidenceRejected',
  {
    code: Schema.Literal('inventory_reconciliation_evidence_rejected'),
    reason: Schema.Literals(['CORRELATION_NOT_ENDED', 'EVIDENCE_LIMIT_EXCEEDED']),
  },
) {}
