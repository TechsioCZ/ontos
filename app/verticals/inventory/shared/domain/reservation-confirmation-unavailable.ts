import { Schema } from 'effect';

export class ReservationConfirmationUnavailable extends Schema.TaggedError<ReservationConfirmationUnavailable>()(
  'ReservationConfirmationUnavailable',
  {
    code: Schema.Literal('reservation_confirmation_unavailable'),
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}
