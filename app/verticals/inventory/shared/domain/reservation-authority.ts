import { Schema } from 'effect';

import { InventoryBackendConfigurationSchema } from './inventory-backend-configuration.ts';
import { InventoryBackendIdSchema } from './inventory-backend-identifiers.ts';
import { ReservationAuthorityEffectIdSchema } from './reservation-issuer-failure-fields.ts';
import { StockQuantitySchema } from './stock-position.ts';
import { InventoryReservationAuthorityDecisionSchema } from './inventory-authority.ts';
import { InventoryBackendSchema } from '../inventory-launch-scope.ts';
import { StockItemRefSchema } from '../resources/stock-item.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';

const boundedIdentifier = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const ReservationInstantSchema = Schema.toEncoded(Schema.DateTimeUtcFromString);

export { ReservationAuthorityUnavailable } from './reservation-authority-unavailable.ts';
export { ReservationEffectIndeterminate } from './reservation-effect-indeterminate.ts';
export { ReservationIssuerEvidenceRejected } from './reservation-issuer-evidence-rejected.ts';
export const ReservationAuthorityOperationSchema = Schema.Literals([
  'RESERVATION_CONFIRMATION',
  'COMMITMENT_PROTECTION',
]);

export const ReservationAuthorityAllocationSchema = Schema.Struct({
  allocationId: boundedIdentifier.pipe(Schema.brand('ReservationAuthorityAllocationId')),
  quantity: StockQuantitySchema,
  stockItemRef: StockItemRefSchema,
  stockPositionRef: StockPositionRefSchema,
}).check(
  Schema.makeFilter(({ quantity, stockItemRef, stockPositionRef }) =>
    stockItemRef.tenantId === stockPositionRef.tenantId && stockItemRef.tenantId === quantity.unitRef.tenantId
      ? undefined
      : 'Reservation Allocation references and Quantity Unit must share one Tenant',
  ),
);
export type ReservationAuthorityAllocation = typeof ReservationAuthorityAllocationSchema.Type;

export const ReservationAuthorityAllocationsSchema = Schema.Array(ReservationAuthorityAllocationSchema).check(
  Schema.isMinLength(1),
  Schema.makeFilter((allocations) =>
    new Set(allocations.map(({ allocationId }) => allocationId)).size === allocations.length
      ? undefined
      : 'Reservation Allocation identities must be unique within one exact Reservation scope',
  ),
);

export const ReservationAuthorityExactScopeSchema = Schema.Struct({
  allocations: ReservationAuthorityAllocationsSchema,
  attemptId: InventoryReservationAuthorityDecisionSchema.fields.attemptId,
  reservationId: InventoryReservationAuthorityDecisionSchema.fields.reservationId,
  tenantId: InventoryBackendConfigurationSchema.fields.tenantId,
}).check(
  Schema.makeFilter(({ allocations, tenantId }) =>
    allocations.every(
      ({ quantity, stockItemRef, stockPositionRef }) =>
        String(stockItemRef.tenantId) === String(tenantId) &&
        stockPositionRef.tenantId === tenantId &&
        quantity.unitRef.tenantId === tenantId,
    )
      ? undefined
      : 'Every Reservation Allocation must belong to the Reservation Tenant',
  ),
);
export type ReservationAuthorityExactScope = typeof ReservationAuthorityExactScopeSchema.Type;

export const ReservationAuthorityIssueRequestSchema = Schema.Struct({
  configuration: InventoryBackendConfigurationSchema,
  effectId: ReservationAuthorityEffectIdSchema,
  operation: ReservationAuthorityOperationSchema,
  reservation: ReservationAuthorityExactScopeSchema,
}).check(
  Schema.makeFilter(({ configuration, reservation }) =>
    configuration.tenantId === reservation.tenantId
      ? undefined
      : 'Reservation and selected Inventory Backend configuration must share one Tenant',
  ),
);
export type ReservationAuthorityIssueRequest = typeof ReservationAuthorityIssueRequestSchema.Type;

export const ReservationEvidenceIssuerSchema = Schema.Struct({
  backend: InventoryBackendSchema,
  backendId: InventoryBackendIdSchema,
  origin: Schema.Literals(['EXTERNAL_BUSINESS_SYSTEM', 'ONTOS_WMS']),
});

export const ReservationAuthorityProofSchema = Schema.Struct({
  allocations: ReservationAuthorityAllocationsSchema,
  attemptId: ReservationAuthorityExactScopeSchema.fields.attemptId,
  customerConfigurationId: InventoryBackendConfigurationSchema.fields.customerConfigurationId,
  ownerEvidenceRef: boundedIdentifier.pipe(Schema.brand('ReservationAuthorityOwnerEvidenceRef')),
  reservationId: ReservationAuthorityExactScopeSchema.fields.reservationId,
  tenantId: ReservationAuthorityExactScopeSchema.fields.tenantId,
  validFrom: ReservationInstantSchema,
  validUntil: ReservationInstantSchema,
});

export const ReservationAuthorityConfirmedObservationSchema = Schema.Struct({
  effectId: ReservationAuthorityEffectIdSchema,
  evidence: ReservationAuthorityProofSchema,
  issuer: ReservationEvidenceIssuerSchema,
  kind: Schema.Literal('CONFIRMED'),
  operation: ReservationAuthorityOperationSchema,
});

export const ReservationAuthorityObservationSchema = Schema.Union([
  ReservationAuthorityConfirmedObservationSchema,
  Schema.Struct({
    effectId: ReservationAuthorityEffectIdSchema,
    kind: Schema.Literal('UNSUPPORTED'),
  }),
  Schema.Struct({
    effectAbsenceProven: Schema.Literal(false),
    effectId: ReservationAuthorityEffectIdSchema,
    kind: Schema.Literal('UNAVAILABLE'),
    recovery: Schema.Literal('VERIFY_OR_RECOVER_ORIGINAL_EFFECT'),
  }),
  Schema.Struct({
    competingFreshEffectAllowed: Schema.Literal(false),
    effectId: ReservationAuthorityEffectIdSchema,
    kind: Schema.Literal('INDETERMINATE'),
    recovery: Schema.Literal('RECOVER_ORIGINAL_EFFECT'),
  }),
]);
export type ReservationAuthorityObservation = typeof ReservationAuthorityObservationSchema.Type;

export const AuthoritativeReservationEvidenceSchema = Schema.Struct({
  effectId: ReservationAuthorityEffectIdSchema,
  evidence: ReservationAuthorityProofSchema,
  issuer: ReservationEvidenceIssuerSchema,
  kind: Schema.Literal('AUTHORITATIVE_RESERVATION_EVIDENCE'),
  operation: ReservationAuthorityOperationSchema,
});
export type AuthoritativeReservationEvidence = typeof AuthoritativeReservationEvidenceSchema.Type;
