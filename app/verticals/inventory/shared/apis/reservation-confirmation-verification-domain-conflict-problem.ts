import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';

import { ReservationConfirmationRejected } from '../domain/reservation-confirmation.ts';

export const ReservationConfirmationVerificationDomainConflictProblemSchema = makeProblemDetailsSchema(
  'ReservationConfirmationVerificationDomainConflictProblem',
  409,
  { reasonCode: ReservationConfirmationRejected.fields.reason },
);
export type ReservationConfirmationVerificationDomainConflictProblem =
  typeof ReservationConfirmationVerificationDomainConflictProblemSchema.Type;
