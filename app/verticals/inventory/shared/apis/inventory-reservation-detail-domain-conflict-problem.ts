import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';

import { InventoryObligationRejected } from '../domain/inventory-obligation.ts';

export const InventoryReservationDetailDomainConflictProblemSchema = makeProblemDetailsSchema(
  'InventoryReservationDetailDomainConflictProblem',
  409,
  { reasonCode: InventoryObligationRejected.fields.reason },
);
export type InventoryReservationDetailDomainConflictProblem =
  typeof InventoryReservationDetailDomainConflictProblemSchema.Type;
