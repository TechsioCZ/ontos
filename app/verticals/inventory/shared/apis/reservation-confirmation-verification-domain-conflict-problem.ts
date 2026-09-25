import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

import { ReservationConfirmationRejected } from '../domain/reservation-confirmation.ts';

const problemDetailsRepresentation = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export class ReservationConfirmationVerificationDomainConflictProblem extends Schema.TaggedError<ReservationConfirmationVerificationDomainConflictProblem>()(
  'ReservationConfirmationVerificationDomainConflictProblem',
  {
    detail: Schema.String,
    reasonCode: ReservationConfirmationRejected.fields.reason,
    status: Schema.Literal(409),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const ReservationConfirmationVerificationDomainConflictProblemSchema =
  ReservationConfirmationVerificationDomainConflictProblem.pipe(
    problemDetailsRepresentation,
    HttpApiSchema.status(409),
  );
