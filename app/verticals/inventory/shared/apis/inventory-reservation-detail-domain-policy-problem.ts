import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';

import { InventoryObligationRejected } from '../domain/inventory-obligation.ts';

export const InventoryReservationDetailDomainPolicyProblemSchema = makeProblemDetailsSchema(
  'InventoryReservationDetailDomainPolicyProblem',
  422,
  { reasonCode: InventoryObligationRejected.fields.reason },
);
export type InventoryReservationDetailDomainPolicyProblem =
  typeof InventoryReservationDetailDomainPolicyProblemSchema.Type;
