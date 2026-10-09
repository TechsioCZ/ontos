import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const ReservationConfirmationVerificationDomainUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'ReservationConfirmationVerificationDomainUnavailableProblem',
  503,
  { reasonCode: Schema.Literal('reservation_confirmation_unavailable') },
);
export type ReservationConfirmationVerificationDomainUnavailableProblem =
  typeof ReservationConfirmationVerificationDomainUnavailableProblemSchema.Type;
