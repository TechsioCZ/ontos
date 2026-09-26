import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export class InventoryEffectOutcomeDomainUnavailableProblem extends Schema.TaggedError<InventoryEffectOutcomeDomainUnavailableProblem>()(
  'InventoryEffectOutcomeDomainUnavailableProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literal('inventory_effect_ledger_unavailable'),
    retryable: Schema.Literal(true),
    status: Schema.Literal(503),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const InventoryEffectOutcomeDomainUnavailableProblemSchema = InventoryEffectOutcomeDomainUnavailableProblem.pipe(
  problemDetailsRepresentation,
  HttpApiSchema.status(503),
);
