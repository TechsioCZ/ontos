import { Schema } from 'effect';

import { CatalogToStockBindingSchema } from './catalog-to-stock-binding.ts';
import { InventoryBackendConfigurationSchema } from './inventory-backend-configuration.ts';
import {
  ImportedCommittedObligationSchema,
  RuntimeCommittedInventoryObligationSchema,
} from './inventory-obligation.ts';
import {
  IndeterminateReservationCreateEffectSchema,
  InventoryReservationCreateRequestSchema,
  ReconciliationRequiredReservationCreateEffectSchema,
  ReservationCreateAllocationSchema,
} from './inventory-reservation-create.ts';
import type { RequestedReservationCreateEffectSchema } from './inventory-reservation-create.ts';
import { InventorySourceAssertionEvaluationSchema } from './inventory-source-assertion.ts';
import { PhysicalStockEffectRecordSchema } from './physical-stock-effect.ts';
import {
  StockPositionOnHandEvidenceSchema,
  StockPositionReservedEvidenceSchema,
  StockPositionSchema,
} from './stock-position.ts';
import { StockItemSchema } from './stock-item.ts';
import { StockLocationSchema } from './stock-location.ts';

const constraintCommon = {
  attemptId: InventoryReservationCreateRequestSchema.fields.reservation.fields.origin.fields.attemptId,
  authority: InventoryBackendConfigurationSchema,
  countsTowardReserved: Schema.Literal(false),
  effectId: InventoryReservationCreateRequestSchema.fields.effectId,
  meaning: Schema.Literal('UNRESOLVED_RESERVATION_EFFECT_CONSTRAINT'),
  mutationId: InventoryReservationCreateRequestSchema.fields.mutationId,
  provesReusableOnHand: Schema.Literal(false),
  requestedAt: InventoryReservationCreateRequestSchema.fields.requestedAt,
  sourceActionInvocationId: InventoryReservationCreateRequestSchema.fields.sourceActionInvocationId,
} as const;

export const ExactUnresolvedReservationEffectConstraintSchema = Schema.TaggedStruct('EXACT', {
  ...constraintCommon,
  constrainedAllocations: ReconciliationRequiredReservationCreateEffectSchema.fields.constrainedAllocations,
  observedAt: ReconciliationRequiredReservationCreateEffectSchema.fields.observedAt,
  ownerEvidenceRef: ReconciliationRequiredReservationCreateEffectSchema.fields.ownerEvidenceRef,
});

export const IndeterminateUnresolvedReservationEffectConstraintSchema = Schema.TaggedStruct('INDETERMINATE', {
  ...constraintCommon,
  observedAt: Schema.optionalKey(IndeterminateReservationCreateEffectSchema.fields.observedAt),
  possibleAllocations: Schema.Array(ReservationCreateAllocationSchema).check(Schema.isMinLength(1)),
  reason: Schema.Union([IndeterminateReservationCreateEffectSchema.fields.reason, Schema.Literal('DISPATCH_PENDING')]),
});

export const UnresolvedReservationEffectConstraintSchema = Schema.Union([
  ExactUnresolvedReservationEffectConstraintSchema,
  IndeterminateUnresolvedReservationEffectConstraintSchema,
]);
export type UnresolvedReservationEffectConstraint = typeof UnresolvedReservationEffectConstraintSchema.Type;

const sourceCommon = {
  onHand: StockPositionOnHandEvidenceSchema,
  ownerConfiguration: InventoryBackendConfigurationSchema,
  physicalOnHandReusableProof: Schema.Literal('NOT_PROVIDED'),
} as const;

export const OwnerManagedStockSourceEvidenceSchema = Schema.TaggedStruct('OWNER_MANAGED', {
  ...sourceCommon,
});

export const ExternalStockSourceAssertionEvidenceSchema = Schema.TaggedStruct('EXTERNAL_SOURCE_ASSERTION', {
  ...sourceCommon,
  evaluation: InventorySourceAssertionEvaluationSchema,
  materialEffects: Schema.Array(PhysicalStockEffectRecordSchema),
});

export const MissingExternalStockSourceEvidenceSchema = Schema.TaggedStruct('MISSING', {
  ...sourceCommon,
  meaning: Schema.Literal('EXTERNAL_SOURCE_ASSERTION'),
});

export const StockSourceEvidenceForAvailabilitySchema = Schema.Union([
  OwnerManagedStockSourceEvidenceSchema,
  ExternalStockSourceAssertionEvidenceSchema,
  MissingExternalStockSourceEvidenceSchema,
]);
export type StockSourceEvidenceForAvailability = typeof StockSourceEvidenceForAvailabilitySchema.Type;

export const InventoryStockEvidenceForAvailabilitySchema = Schema.Struct({
  binding: CatalogToStockBindingSchema,
  committedObligations: Schema.Array(
    Schema.Union([RuntimeCommittedInventoryObligationSchema, ImportedCommittedObligationSchema]),
  ),
  customerFacingAvailabilityPublished: Schema.Literal(false),
  position: StockPositionSchema,
  provisionalReserved: StockPositionReservedEvidenceSchema,
  purpose: Schema.Literal('STOCK_EVIDENCE_ONLY'),
  sourceEvidence: StockSourceEvidenceForAvailabilitySchema,
  stockItem: StockItemSchema,
  stockLocation: StockLocationSchema,
  unresolvedReservationEffectConstraints: Schema.Array(UnresolvedReservationEffectConstraintSchema),
});
export type InventoryStockEvidenceForAvailability = typeof InventoryStockEvidenceForAvailabilitySchema.Type;

export class CurrentStockEvidenceForAvailabilityRejected extends Schema.TaggedError<CurrentStockEvidenceForAvailabilityRejected>()(
  'CurrentStockEvidenceForAvailabilityRejected',
  {
    code: Schema.Literal('current_stock_evidence_for_availability_rejected'),
    reason: Schema.Literals([
      'AUTHORITY_NOT_FOUND',
      'BINDING_NOT_FOUND',
      'EVIDENCE_SCOPE_MISMATCH',
      'INVALID_EVIDENCE',
      'POSITION_NOT_CURRENT',
      'POSITION_NOT_FOUND',
      'STOCK_ITEM_NOT_CURRENT',
      'STOCK_ITEM_NOT_FOUND',
      'STOCK_LOCATION_NOT_ACTIVE',
      'STOCK_LOCATION_NOT_FOUND',
    ]),
  },
) {}

export type ReservationCreateEffectForAvailability =
  | typeof RequestedReservationCreateEffectSchema.Type
  | typeof ReconciliationRequiredReservationCreateEffectSchema.Type
  | typeof IndeterminateReservationCreateEffectSchema.Type;

export { CurrentStockEvidenceForAvailabilityUnavailable } from './current-stock-evidence-for-availability-unavailable.ts';
