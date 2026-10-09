import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const InventoryReconciliationEvidenceDomainUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'InventoryReconciliationEvidenceDomainUnavailableProblem',
  503,
  { reasonCode: Schema.Literal('inventory_reconciliation_evidence_unavailable') },
);
export type InventoryReconciliationEvidenceDomainUnavailableProblem =
  typeof InventoryReconciliationEvidenceDomainUnavailableProblemSchema.Type;
