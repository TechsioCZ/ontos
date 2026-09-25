import { Schema } from 'effect';

import { InventoryBackendIdSchema } from './inventory-backend-identifiers.ts';

export class InventoryReservationGuaranteeUnsupported extends Schema.TaggedError<InventoryReservationGuaranteeUnsupported>()(
  'InventoryReservationGuaranteeUnsupported',
  {
    code: Schema.Literal('inventory_reservation_guarantee_unsupported'),
    fallbackApplied: Schema.Literal(false),
    proofIssued: Schema.Literal(false),
    reason: Schema.Literal('selected_backend_does_not_support_required_guarantee'),
    selectedBackendId: InventoryBackendIdSchema,
  },
) {}
