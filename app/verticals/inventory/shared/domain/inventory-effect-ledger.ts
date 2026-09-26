import { Schema } from 'effect';

import { InventoryEffectLedgerConflict } from './inventory-effect-ledger-conflict.ts';
import { InventoryEffectLedgerEffectIdSchema } from './inventory-effect-ledger-identifiers.ts';
import { InventoryEffectLedgerRejected } from './inventory-effect-ledger-rejected.ts';
import { CommitmentProtectionEffectRequestSchema, CommitmentProtectionEffectSchema } from './commitment-protection.ts';
import {
  InventoryReservationCreateRequestSchema,
  ReservationCreateEffectSchema,
} from './inventory-reservation-create.ts';
import { ReservationReleaseEffectSchema, ReservationReleaseRequestSchema } from './inventory-reservation-release.ts';
import { PhysicalStockEffectRecordSchema, PhysicalStockEffectRequestSchema } from './physical-stock-effect.ts';
import { InventoryEffectLedgerUnavailable } from './inventory-effect-ledger-unavailable.ts';

const instant = Schema.toEncoded(Schema.DateTimeUtcFromString);

export { InventoryEffectLedgerEffectIdSchema } from './inventory-effect-ledger-identifiers.ts';
export const InventoryEffectLedgerKindSchema = Schema.Literals([
  'RESERVATION_CREATE',
  'RESERVATION_RELEASE',
  'ESTABLISH_COMMITMENT_PROTECTION',
  'PHYSICAL_RECEIPT',
  'PHYSICAL_ISSUE',
]);
export const InventoryEffectLedgerStateSchema = Schema.Literals([
  'REQUESTED',
  'INDETERMINATE',
  'SUCCEEDED',
  'REJECTED',
]);

export const ReservationCreateInventoryEffectLedgerIntentSchema = Schema.TaggedStruct('RESERVATION_CREATE', {
  request: Schema.Struct({
    authority: InventoryReservationCreateRequestSchema.fields.authority,
    commerceContext: InventoryReservationCreateRequestSchema.fields.commerceContext,
    effectId: InventoryReservationCreateRequestSchema.fields.effectId,
    legalEntityId: InventoryReservationCreateRequestSchema.fields.legalEntityId,
    reservation: InventoryReservationCreateRequestSchema.fields.reservation,
  }),
});
export const ReservationReleaseInventoryEffectLedgerIntentSchema = Schema.TaggedStruct('RESERVATION_RELEASE', {
  request: Schema.Struct({
    effectId: ReservationReleaseRequestSchema.fields.effectId,
    legalEntityId: ReservationReleaseRequestSchema.fields.legalEntityId,
    reservation: ReservationReleaseRequestSchema.fields.reservation,
  }),
});
export const CommitmentProtectionInventoryEffectLedgerIntentSchema = Schema.TaggedStruct(
  'ESTABLISH_COMMITMENT_PROTECTION',
  { request: CommitmentProtectionEffectRequestSchema },
);
const physicalBusinessRequest = {
  backend: PhysicalStockEffectRequestSchema.fields.backend,
  backendConfigurationRef: PhysicalStockEffectRequestSchema.fields.backendConfigurationRef,
  backendId: PhysicalStockEffectRequestSchema.fields.backendId,
  customerConfigurationId: PhysicalStockEffectRequestSchema.fields.customerConfigurationId,
  effectId: PhysicalStockEffectRequestSchema.fields.effectId,
  kind: PhysicalStockEffectRequestSchema.fields.kind,
  legalEntityId: PhysicalStockEffectRequestSchema.fields.legalEntityId,
  positionRef: PhysicalStockEffectRequestSchema.fields.positionRef,
  quantity: PhysicalStockEffectRequestSchema.fields.quantity,
  reason: PhysicalStockEffectRequestSchema.fields.reason,
  stockItemRef: PhysicalStockEffectRequestSchema.fields.stockItemRef,
  stockLocationRef: PhysicalStockEffectRequestSchema.fields.stockLocationRef,
} as const;
const physicalReceiptIntent = Schema.TaggedStruct('PHYSICAL_RECEIPT', {
  request: Schema.Struct(physicalBusinessRequest).check(
    Schema.makeFilter(({ kind }) => (kind === 'RECEIPT' ? undefined : 'Receipt ledger intent must carry a Receipt')),
  ),
});
export const PhysicalIssueInventoryEffectLedgerIntentSchema = Schema.TaggedStruct('PHYSICAL_ISSUE', {
  request: Schema.Struct(physicalBusinessRequest).check(
    Schema.makeFilter(({ kind }) => (kind === 'ISSUE' ? undefined : 'Issue ledger intent must carry an Issue')),
  ),
});
export const InventoryEffectLedgerIntentSchema = Schema.Union([
  ReservationCreateInventoryEffectLedgerIntentSchema,
  ReservationReleaseInventoryEffectLedgerIntentSchema,
  CommitmentProtectionInventoryEffectLedgerIntentSchema,
  physicalReceiptIntent,
  PhysicalIssueInventoryEffectLedgerIntentSchema,
]);
export type InventoryEffectLedgerIntent = typeof InventoryEffectLedgerIntentSchema.Type;

export const PhysicalIssueInventoryEffectLedgerResolutionSchema = Schema.TaggedStruct('PHYSICAL_ISSUE', {
  effect: PhysicalStockEffectRecordSchema,
});

export const InventoryEffectLedgerResolutionSchema = Schema.Union([
  Schema.TaggedStruct('RESERVATION_CREATE', { effect: ReservationCreateEffectSchema }),
  Schema.TaggedStruct('RESERVATION_RELEASE', { effect: ReservationReleaseEffectSchema }),
  Schema.TaggedStruct('ESTABLISH_COMMITMENT_PROTECTION', { effect: CommitmentProtectionEffectSchema }),
  Schema.TaggedStruct('PHYSICAL_RECEIPT', { effect: PhysicalStockEffectRecordSchema }),
  PhysicalIssueInventoryEffectLedgerResolutionSchema,
]);
export type InventoryEffectLedgerResolution = typeof InventoryEffectLedgerResolutionSchema.Type;

export const InventoryEffectLedgerRecordSchema = Schema.Struct({
  currentState: InventoryEffectLedgerStateSchema,
  effectId: InventoryEffectLedgerEffectIdSchema,
  intent: InventoryEffectLedgerIntentSchema,
  requestedAt: instant,
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- Persisted ledger snapshots use explicit JSON null before owner resolution; expires: 2027-03-31.
  resolution: Schema.NullOr(InventoryEffectLedgerResolutionSchema),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  tenantId: PhysicalStockEffectRequestSchema.fields.positionRef.fields.tenantId,
  updatedAt: instant,
});
export type InventoryEffectLedgerRecord = typeof InventoryEffectLedgerRecordSchema.Type;

export const InventoryEffectLedgerErrorSchema = Schema.Union([
  InventoryEffectLedgerConflict,
  InventoryEffectLedgerRejected,
  InventoryEffectLedgerUnavailable,
]);
export type InventoryEffectLedgerError = typeof InventoryEffectLedgerErrorSchema.Type;

export { InventoryEffectLedgerUnavailable } from './inventory-effect-ledger-unavailable.ts';
export { InventoryEffectLedgerConflict } from './inventory-effect-ledger-conflict.ts';
export { InventoryEffectLedgerRejected } from './inventory-effect-ledger-rejected.ts';
