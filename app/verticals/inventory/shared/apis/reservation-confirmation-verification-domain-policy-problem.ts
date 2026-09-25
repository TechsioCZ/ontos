import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

import { ReservationConfirmationRejected } from '../domain/reservation-confirmation.ts';

const problemDetailsRepresentation = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export class ReservationConfirmationVerificationDomainPolicyProblem extends Schema.TaggedError<ReservationConfirmationVerificationDomainPolicyProblem>()(
  'ReservationConfirmationVerificationDomainPolicyProblem',
  {
    detail: Schema.String,
    reasonCode: ReservationConfirmationRejected.fields.reason,
    status: Schema.Literal(422),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const ReservationConfirmationVerificationDomainPolicyProblemSchema =
  ReservationConfirmationVerificationDomainPolicyProblem.pipe(problemDetailsRepresentation, HttpApiSchema.status(422));
