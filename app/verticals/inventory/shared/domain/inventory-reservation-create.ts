import { Schema } from 'effect';

import { CatalogStockDemandSchema } from './catalog-to-stock-binding.ts';
import { CatalogToStockBindingResolutionFailure } from './catalog-to-stock-binding-resolution.ts';
import { InventoryBackendConfigurationSchema } from './inventory-backend-configuration.ts';
import {
  InventoryObligationRequirementSchema,
  InventoryStockAllocationSchema,
  ProvisionalInventoryReservationSchema,
} from './inventory-obligation.ts';
import { InventoryReservationCreateUnavailable } from './inventory-reservation-create-unavailable.ts';
import { InventoryReservationGuaranteeUnsupported } from './inventory-reservation-guarantee-unsupported.ts';
import { ActionInvocationIdSchema, LegalEntityIdSchema } from './physical-stock-effect.ts';
import { ReservationAuthorityEffectIdSchema } from './reservation-issuer-failure-fields.ts';
import { TrustedCurrentCommercePurchasingContextSchema } from './stock-sharing-eligibility.ts';
import { CustomerConfigurationIdSchema, OrderCommitmentAttemptIdSchema } from '../inventory-launch-scope.ts';
import { InventoryReservationRefSchema } from '../resources/inventory-reservation.ts';

const boundedText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const instant = Schema.toEncoded(Schema.DateTimeUtcFromString);
export const InventoryReservationCreateMutationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('InventoryReservationCreateMutationId'),
);
const reservationCreateIndeterminateReasonSchema = Schema.Literals([
  'DISPATCH_PENDING',
  'BACKEND_OUTCOME_UNKNOWN',
  'EVIDENCE_UNVERIFIABLE',
  'AUTHORITY_UNAVAILABLE',
]);
const reservationCreateRejectedReasonSchema = Schema.Literals([
  'INSUFFICIENT_STOCK',
  'BACKEND_REJECTED',
  'PRE_COMMIT_COMPENSATED',
]);

export const ReservationCreateAllocationSchema = Schema.Struct({
  allocationId: InventoryStockAllocationSchema.fields.allocationId,
  quantity: InventoryStockAllocationSchema.fields.quantity,
  stockItemRef: InventoryStockAllocationSchema.fields.stockItemRef,
  stockPositionRef: InventoryStockAllocationSchema.fields.positionRef,
});
export type ReservationCreateAllocation = typeof ReservationCreateAllocationSchema.Type;

export const CreateInventoryReservationPayloadSchema = Schema.Struct({
  attemptId: OrderCommitmentAttemptIdSchema,
  commerceContext: TrustedCurrentCommercePurchasingContextSchema,
  customerConfigurationId: CustomerConfigurationIdSchema,
  demands: Schema.Array(CatalogStockDemandSchema).check(Schema.isMinLength(1)),
  effectId: ReservationAuthorityEffectIdSchema,
  reservationRef: InventoryReservationRefSchema,
}).check(
  Schema.makeFilter(({ commerceContext, customerConfigurationId, demands, reservationRef }) => {
    const { tenantId } = reservationRef;
    if (
      commerceContext.tenantId !== tenantId ||
      commerceContext.customerConfigurationId !== customerConfigurationId ||
      demands.some(
        ({ catalogSelection: { productRef }, unitRef }) =>
          productRef.tenantId !== tenantId || unitRef.tenantId !== tenantId,
      )
    ) {
      return 'Reservation request, Commerce context, demand, and Unit must share one Tenant and Customer Configuration';
    }
    const occurrences = demands.map(({ purchaseDemandOccurrenceId }) => purchaseDemandOccurrenceId);
    return new Set(occurrences).size === occurrences.length
      ? undefined
      : 'Purchase Demand Occurrence identities must remain distinct';
  }),
);
export type CreateInventoryReservationPayload = typeof CreateInventoryReservationPayloadSchema.Type;

export const InventoryReservationCreateRequestSchema = Schema.Struct({
  authority: InventoryBackendConfigurationSchema,
  commerceContext: TrustedCurrentCommercePurchasingContextSchema,
  effectId: ReservationAuthorityEffectIdSchema,
  legalEntityId: LegalEntityIdSchema,
  mutationId: InventoryReservationCreateMutationIdSchema,
  requestedAt: instant,
  reservation: Schema.Struct({
    origin: Schema.Struct({
      attemptId: OrderCommitmentAttemptIdSchema,
      kind: Schema.Literal('ORDER_COMMITMENT_ATTEMPT'),
    }),
    ref: InventoryReservationRefSchema,
    requirements: Schema.Array(InventoryObligationRequirementSchema).check(Schema.isMinLength(1)),
  }),
  sourceActionInvocationId: ActionInvocationIdSchema,
});
export type InventoryReservationCreateRequest = typeof InventoryReservationCreateRequestSchema.Type;

export const ReservationCreateBackendObservationSchema = Schema.Union([
  Schema.TaggedStruct('ESTABLISHED', {
    allocations: Schema.Array(ReservationCreateAllocationSchema).check(Schema.isMinLength(1)),
    effectId: ReservationAuthorityEffectIdSchema,
    establishedAt: instant,
    ownerEvidenceRef: boundedText,
  }),
  Schema.TaggedStruct('REJECTED', {
    effectAbsenceProven: Schema.Literal(true),
    effectId: ReservationAuthorityEffectIdSchema,
    reason: reservationCreateRejectedReasonSchema,
  }),
  Schema.TaggedStruct('PARTIAL', {
    constrainedAllocations: Schema.Array(ReservationCreateAllocationSchema).check(Schema.isMinLength(1)),
    effectId: ReservationAuthorityEffectIdSchema,
    observedAt: instant,
    ownerEvidenceRef: boundedText,
  }),
  Schema.TaggedStruct('INDETERMINATE', {
    effectId: ReservationAuthorityEffectIdSchema,
    observedAt: instant,
    reason: reservationCreateIndeterminateReasonSchema,
  }),
]);
export type ReservationCreateBackendObservation = typeof ReservationCreateBackendObservationSchema.Type;

const effectBase = {
  request: InventoryReservationCreateRequestSchema,
} as const;

export const RequestedReservationCreateEffectSchema = Schema.TaggedStruct('REQUESTED', effectBase);
export const EstablishedReservationCreateEffectSchema = Schema.TaggedStruct('ESTABLISHED', {
  ...effectBase,
  ownerEvidenceRef: boundedText,
  reservation: ProvisionalInventoryReservationSchema,
});
export const ReconciliationRequiredReservationCreateEffectSchema = Schema.TaggedStruct('RECONCILIATION_REQUIRED', {
  ...effectBase,
  constrainedAllocations: Schema.Array(ReservationCreateAllocationSchema).check(Schema.isMinLength(1)),
  observedAt: instant,
  ownerEvidenceRef: boundedText,
});
export const IndeterminateReservationCreateEffectSchema = Schema.TaggedStruct('INDETERMINATE', {
  ...effectBase,
  observedAt: instant,
  possibleConstrainedAllocations: Schema.Array(ReservationCreateAllocationSchema).check(Schema.isMinLength(1)),
  reason: reservationCreateIndeterminateReasonSchema,
});
export const ReservationCreatePreCommitCompensationSchema = Schema.Struct({
  authorityIssuer: Schema.Struct({
    backend: InventoryBackendConfigurationSchema.fields.selection.fields.backend,
    backendId: InventoryBackendConfigurationSchema.fields.selection.fields.backendId,
    origin: Schema.Literals(['EXTERNAL_BUSINESS_SYSTEM', 'ONTOS_WMS']),
  }),
  cleanedAllocations: Schema.Array(ReservationCreateAllocationSchema),
  cleanedAt: instant,
  cleanupEvidenceRef: boundedText,
  cleanupOutcome: Schema.Literals(['CLEANED', 'ALREADY_CLEANED']),
  orderProof: Schema.TaggedStruct('NOT_COMMITTED_CLOSED', {
    closureEvidenceRef: boundedText,
    nonCommitEvidenceRef: boundedText,
    observedAt: instant,
  }),
  originalEffectState: Schema.Literals(['REQUESTED', 'RECONCILIATION_REQUIRED', 'INDETERMINATE']),
  originalObservedAt: Schema.optionalKey(instant),
  originalOwnerEvidenceRef: Schema.optionalKey(boundedText),
});

export const ResolvedNoReservationCreateEffectSchema = Schema.TaggedStruct('RESOLVED_NO_RESERVATION', {
  ...effectBase,
  effectAbsenceProven: Schema.Literal(true),
  observedAt: instant,
  preCommitCompensation: Schema.optionalKey(ReservationCreatePreCommitCompensationSchema),
  reason: reservationCreateRejectedReasonSchema,
}).check(
  Schema.makeFilter(({ preCommitCompensation, reason }) =>
    (reason === 'PRE_COMMIT_COMPENSATED') === (preCommitCompensation !== undefined)
      ? undefined
      : 'Pre-commit compensation evidence must exist exactly for PRE_COMMIT_COMPENSATED resolution',
  ),
);
export const ReservationCreateEffectSchema = Schema.Union([
  RequestedReservationCreateEffectSchema,
  EstablishedReservationCreateEffectSchema,
  ReconciliationRequiredReservationCreateEffectSchema,
  IndeterminateReservationCreateEffectSchema,
  ResolvedNoReservationCreateEffectSchema,
]);
export type ReservationCreateEffect = typeof ReservationCreateEffectSchema.Type;

const establishedResultFields = {
  effect: EstablishedReservationCreateEffectSchema,
  reservation: ProvisionalInventoryReservationSchema,
} as const;
export const CreateInventoryReservationResultSchema = Schema.Union([
  Schema.Struct({ effect: RequestedReservationCreateEffectSchema, outcome: Schema.Literal('PENDING') }),
  Schema.Struct({ ...establishedResultFields, outcome: Schema.Literal('ESTABLISHED') }),
  Schema.Struct({ ...establishedResultFields, outcome: Schema.Literal('EXACT_REPLAY') }),
  Schema.Struct({
    effect: ReconciliationRequiredReservationCreateEffectSchema,
    outcome: Schema.Literal('RECONCILIATION_REQUIRED'),
  }),
  Schema.Struct({ effect: IndeterminateReservationCreateEffectSchema, outcome: Schema.Literal('INDETERMINATE') }),
  Schema.Struct({
    effect: ResolvedNoReservationCreateEffectSchema,
    outcome: Schema.Literal('RESOLVED_NO_RESERVATION'),
  }),
]);
export type CreateInventoryReservationResult = typeof CreateInventoryReservationResultSchema.Type;

export class InventoryReservationCreateRejected extends Schema.TaggedError<InventoryReservationCreateRejected>()(
  'InventoryReservationCreateRejected',
  {
    code: Schema.Literal('inventory_reservation_create_rejected'),
    effectId: ReservationAuthorityEffectIdSchema,
    reason: Schema.Literals([
      'TENANT_SCOPE_MISMATCH',
      'AUTHORITY_NOT_SELECTED',
      'INSUFFICIENT_CONSTRAINED_STOCK',
      'EFFECT_ID_CONFLICT',
      'ATTEMPT_ALREADY_BOUND',
      'ATTEMPT_HAS_UNRESOLVED_EFFECT',
      'ATTEMPT_ALREADY_RESOLVED',
      'BACKEND_REJECTED_WITHOUT_EFFECT',
      'INVALID_BACKEND_OBSERVATION',
      'COMMERCE_CONTEXT_NOT_ELIGIBLE',
    ]),
  },
) {}

export const CreateInventoryReservationErrorSchema = Schema.Union([
  InventoryReservationCreateRejected,
  InventoryReservationCreateUnavailable,
  CatalogToStockBindingResolutionFailure,
  InventoryReservationGuaranteeUnsupported,
]);
export type CreateInventoryReservationError = typeof CreateInventoryReservationErrorSchema.Type;

export { InventoryReservationCreateUnavailable } from './inventory-reservation-create-unavailable.ts';
