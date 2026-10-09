import { CurrentStockEvidenceForAvailabilityResponseSchema } from '@app/inventory/api/current-stock-evidence-for-availability';
import { InventoryBackendConfigurationSchema } from '@app/inventory/backend-configuration';
import { Schema } from 'effect';

/** Provider-neutral owner snapshots retain all stock, obligation, coverage and effect meanings. */
export const AvailabilityInventoryPositionEvidenceSchema =
  CurrentStockEvidenceForAvailabilityResponseSchema.fields.evidence;
export type AvailabilityInventoryPositionEvidence = typeof AvailabilityInventoryPositionEvidenceSchema.Type;

/** A snapshot is not proof that its producer is Inventory; the trusted owner port establishes that boundary. */
export const AvailabilityStockInputSchema = Schema.Struct({
  authorityPath: Schema.Literal('INVENTORY_PUBLIC_BOUNDARY'),
  fallbackApplied: Schema.Literal(false),
  positions: Schema.Array(AvailabilityInventoryPositionEvidenceSchema),
  selectedBackendConfiguration: InventoryBackendConfigurationSchema,
});
export type AvailabilityStockInput = typeof AvailabilityStockInputSchema.Type;

export class AvailabilitySourceAuthorityRejected extends Schema.TaggedError<AvailabilitySourceAuthorityRejected>()(
  'AvailabilitySourceAuthorityRejected',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    reason: Schema.Literals(['INVALID_OWNER_EVIDENCE', 'SELECTED_AUTHORITY_MISMATCH', 'EVIDENCE_SCOPE_MISMATCH']),
  },
) {}
