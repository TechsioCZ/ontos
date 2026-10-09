import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const InventoryReservationDetailDomainUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'InventoryReservationDetailDomainUnavailableProblem',
  503,
  { reasonCode: Schema.Literal('inventory_obligation_persistence_unavailable') },
);
export type InventoryReservationDetailDomainUnavailableProblem =
  typeof InventoryReservationDetailDomainUnavailableProblemSchema.Type;
