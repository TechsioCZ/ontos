import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

import { InventoryObligationRejected } from '../domain/inventory-obligation.ts';

const problemDetailsRepresentation = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export class InventoryReservationDetailDomainConflictProblem extends Schema.TaggedError<InventoryReservationDetailDomainConflictProblem>()(
  'InventoryReservationDetailDomainConflictProblem',
  {
    detail: Schema.String,
    reasonCode: InventoryObligationRejected.fields.reason,
    status: Schema.Literal(409),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const InventoryReservationDetailDomainConflictProblemSchema =
  InventoryReservationDetailDomainConflictProblem.pipe(problemDetailsRepresentation, HttpApiSchema.status(409));
