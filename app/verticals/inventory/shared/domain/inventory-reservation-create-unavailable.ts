import { Schema } from 'effect';

import { ReservationAuthorityEffectIdSchema } from './reservation-issuer-failure-fields.ts';

export class InventoryReservationCreateUnavailable extends Schema.TaggedError<InventoryReservationCreateUnavailable>()(
  'InventoryReservationCreateUnavailable',
  {
    code: Schema.Literal('inventory_reservation_create_unavailable'),
    effectId: ReservationAuthorityEffectIdSchema,
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}
