import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

import { InventoryObligationRejected } from '../domain/inventory-obligation.ts';

const problemDetailsRepresentation = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export class InventoryReservationDetailDomainPolicyProblem extends Schema.TaggedError<InventoryReservationDetailDomainPolicyProblem>()(
  'InventoryReservationDetailDomainPolicyProblem',
  {
    detail: Schema.String,
    reasonCode: InventoryObligationRejected.fields.reason,
    status: Schema.Literal(422),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const InventoryReservationDetailDomainPolicyProblemSchema = InventoryReservationDetailDomainPolicyProblem.pipe(
  problemDetailsRepresentation,
  HttpApiSchema.status(422),
);
