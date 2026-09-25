import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({
  contentType: 'application/problem+json',
});

export class InventorySourceConflictDetailDomainUnavailableProblem extends Schema.TaggedError<InventorySourceConflictDetailDomainUnavailableProblem>()(
  'InventorySourceConflictDetailDomainUnavailableProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literal('inventory_source_conflict_unavailable'),
    retryable: Schema.Literal(true),
    status: Schema.Literal(503),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const InventorySourceConflictDetailDomainUnavailableProblemSchema =
  InventorySourceConflictDetailDomainUnavailableProblem.pipe(problemDetailsRepresentation, HttpApiSchema.status(503));
