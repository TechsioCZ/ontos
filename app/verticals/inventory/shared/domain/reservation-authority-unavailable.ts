import { Schema } from 'effect';

import { reservationIssuerCommonFailureFields } from './reservation-issuer-failure-fields.ts';

export class ReservationAuthorityUnavailable extends Schema.TaggedError<ReservationAuthorityUnavailable>()(
  'ReservationAuthorityUnavailable',
  {
    ...reservationIssuerCommonFailureFields,
    effectAbsenceProven: Schema.Literal(false),
    reason: Schema.Literal('SELECTED_RESERVATION_AUTHORITY_UNAVAILABLE'),
    recovery: Schema.Literal('VERIFY_OR_RECOVER_ORIGINAL_EFFECT'),
  },
) {}
