import { Schema } from 'effect';

import { ReservationReleaseEffectIdSchema } from './inventory-reservation-release-identifiers.ts';

export class InventoryReservationReleaseUnavailable extends Schema.TaggedError<InventoryReservationReleaseUnavailable>()(
  'InventoryReservationReleaseUnavailable',
  {
    code: Schema.Literal('inventory_reservation_release_unavailable'),
    effectId: Schema.optionalKey(ReservationReleaseEffectIdSchema),
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}
