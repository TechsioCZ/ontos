import { Schema } from 'effect';

import { InventoryBackendIdSchema } from './inventory-backend-identifiers.ts';
import { InventoryBackendSchema } from '../inventory-launch-scope.ts';

export const ReservationAuthorityEffectIdSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
).pipe(Schema.brand('ReservationAuthorityEffectId'));

export const reservationIssuerCommonFailureFields = {
  fallbackApplied: Schema.Literal(false),
  originalEffectId: ReservationAuthorityEffectIdSchema,
  proofIssued: Schema.Literal(false),
  selectedBackend: InventoryBackendSchema,
  selectedBackendId: InventoryBackendIdSchema,
} as const;
