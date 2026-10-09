import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const InventoryEffectOutcomeDomainUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'InventoryEffectOutcomeDomainUnavailableProblem',
  503,
  { reasonCode: Schema.Literal('inventory_effect_ledger_unavailable') },
);
export type InventoryEffectOutcomeDomainUnavailableProblem =
  typeof InventoryEffectOutcomeDomainUnavailableProblemSchema.Type;
