import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export class ReservationConfirmationVerificationDomainUnavailableProblem extends Schema.TaggedError<ReservationConfirmationVerificationDomainUnavailableProblem>()(
  'ReservationConfirmationVerificationDomainUnavailableProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literal('reservation_confirmation_unavailable'),
    retryable: Schema.Literal(true),
    status: Schema.Literal(503),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const ReservationConfirmationVerificationDomainUnavailableProblemSchema =
  ReservationConfirmationVerificationDomainUnavailableProblem.pipe(
    problemDetailsRepresentation,
    HttpApiSchema.status(503),
  );
