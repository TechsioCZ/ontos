import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';

import { ReservationConfirmationRejected } from '../domain/reservation-confirmation.ts';

export const ReservationConfirmationVerificationDomainPolicyProblemSchema = makeProblemDetailsSchema(
  'ReservationConfirmationVerificationDomainPolicyProblem',
  422,
  { reasonCode: ReservationConfirmationRejected.fields.reason },
);
export type ReservationConfirmationVerificationDomainPolicyProblem =
  typeof ReservationConfirmationVerificationDomainPolicyProblemSchema.Type;
