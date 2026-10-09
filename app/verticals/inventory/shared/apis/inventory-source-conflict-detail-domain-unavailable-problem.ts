import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const InventorySourceConflictDetailDomainUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'InventorySourceConflictDetailDomainUnavailableProblem',
  503,
  { reasonCode: Schema.Literal('inventory_source_conflict_unavailable') },
);
export type InventorySourceConflictDetailDomainUnavailableProblem =
  typeof InventorySourceConflictDetailDomainUnavailableProblemSchema.Type;
