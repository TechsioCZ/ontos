import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const InventoryEffectOutcomeDomainConflictProblemSchema = makeProblemDetailsSchema(
  'InventoryEffectOutcomeDomainConflictProblem',
  409,
  { reasonCode: Schema.Literals(['inventory_effect_ledger_conflict', 'inventory_effect_ledger_rejected']) },
);
export type InventoryEffectOutcomeDomainConflictProblem = typeof InventoryEffectOutcomeDomainConflictProblemSchema.Type;
