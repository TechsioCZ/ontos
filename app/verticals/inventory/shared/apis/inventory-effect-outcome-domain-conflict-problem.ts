import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export class InventoryEffectOutcomeDomainConflictProblem extends Schema.TaggedError<InventoryEffectOutcomeDomainConflictProblem>()(
  'InventoryEffectOutcomeDomainConflictProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literals(['inventory_effect_ledger_conflict', 'inventory_effect_ledger_rejected']),
    status: Schema.Literal(409),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const InventoryEffectOutcomeDomainConflictProblemSchema = InventoryEffectOutcomeDomainConflictProblem.pipe(
  problemDetailsRepresentation,
  HttpApiSchema.status(409),
);
