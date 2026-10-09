import { Schema } from 'effect';

import { reservationIssuerCommonFailureFields } from './reservation-issuer-failure-fields.ts';

export class ReservationEffectIndeterminate extends Schema.TaggedError<ReservationEffectIndeterminate>()(
  'ReservationEffectIndeterminate',
  {
    ...reservationIssuerCommonFailureFields,
    competingFreshEffectAllowed: Schema.Literal(false),
    reason: Schema.Literal('RESERVATION_EFFECT_INDETERMINATE'),
    recovery: Schema.Literal('RECOVER_ORIGINAL_EFFECT'),
  },
) {}
