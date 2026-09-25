import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export class InventoryReservationDetailDomainUnavailableProblem extends Schema.TaggedError<InventoryReservationDetailDomainUnavailableProblem>()(
  'InventoryReservationDetailDomainUnavailableProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literal('inventory_obligation_persistence_unavailable'),
    retryable: Schema.Literal(true),
    status: Schema.Literal(503),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const InventoryReservationDetailDomainUnavailableProblemSchema =
  InventoryReservationDetailDomainUnavailableProblem.pipe(problemDetailsRepresentation, HttpApiSchema.status(503));
