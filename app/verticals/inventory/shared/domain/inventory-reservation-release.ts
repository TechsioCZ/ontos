import { Schema } from 'effect';

import { ProvisionalInventoryReservationSchema } from './inventory-obligation.ts';
import { ReservationReleaseEffectIdSchema } from './inventory-reservation-release-identifiers.ts';
import { InventoryReservationReleaseUnavailable } from './inventory-reservation-release-unavailable.ts';
import { ReservationAuthorityAllocationsSchema, ReservationEvidenceIssuerSchema } from './reservation-authority.ts';
import { ResolvedCatalogStockDemandSchema } from './catalog-to-stock-binding.ts';
import { ActionInvocationIdSchema, LegalEntityIdSchema } from './physical-stock-effect.ts';
import { InventoryReservationRefSchema } from '../resources/inventory-reservation.ts';
import { OrderCommitmentAttemptIdSchema } from '../inventory-launch-scope.ts';

const boundedIdentifier = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const releaseInstant = Schema.toEncoded(Schema.DateTimeUtcFromString);

export { ReservationReleaseEffectIdSchema } from './inventory-reservation-release-identifiers.ts';
export const ReservationReleaseMutationIdSchema = Schema.String.check(Schema.isTrimmed(), Schema.isUUID()).pipe(
  Schema.brand('ReservationReleaseMutationId'),
);

export const WholeReservationReleaseScopeSchema = Schema.TaggedStruct('WHOLE_RESERVATION', {});
export const PartialReservationReleaseScopeSchema = Schema.TaggedStruct('PARTIAL_RESERVATION', {
  requirementIds: Schema.Array(ResolvedCatalogStockDemandSchema.fields.purchaseDemandOccurrenceId).check(
    Schema.isMinLength(1),
  ),
});
export const ReservationReleaseScopeSchema = Schema.Union([
  WholeReservationReleaseScopeSchema,
  PartialReservationReleaseScopeSchema,
]);

export const ReleaseInventoryReservationPayloadSchema = Schema.Struct({
  attemptId: OrderCommitmentAttemptIdSchema,
  releaseEffectId: ReservationReleaseEffectIdSchema,
  reservationRef: InventoryReservationRefSchema,
  scope: ReservationReleaseScopeSchema,
});
export type ReleaseInventoryReservationPayload = typeof ReleaseInventoryReservationPayloadSchema.Type;

export const ReservationReleaseRequestSchema = Schema.Struct({
  effectId: ReservationReleaseEffectIdSchema,
  legalEntityId: LegalEntityIdSchema,
  mutationId: ReservationReleaseMutationIdSchema,
  requestedAt: releaseInstant,
  reservation: ProvisionalInventoryReservationSchema,
  sourceActionInvocationId: ActionInvocationIdSchema,
});
export type ReservationReleaseRequest = typeof ReservationReleaseRequestSchema.Type;

export const ReservationReleaseNotCommittedClosedTruthSchema = Schema.TaggedStruct('NOT_COMMITTED_CLOSED', {
  closureEvidenceRef: boundedIdentifier,
  nonCommitEvidenceRef: boundedIdentifier,
  observedAt: releaseInstant,
});
export const ReservationReleaseCommittedTruthSchema = Schema.TaggedStruct('COMMITTED', {
  evidenceRef: boundedIdentifier,
  observedAt: releaseInstant,
});
export const ReservationReleaseNotCommittedOpenTruthSchema = Schema.TaggedStruct('NOT_COMMITTED_OPEN', {
  evidenceRef: boundedIdentifier,
  observedAt: releaseInstant,
});
export const ReservationReleaseOrderIndeterminateTruthSchema = Schema.TaggedStruct('INDETERMINATE', {
  observedAt: releaseInstant,
  reason: Schema.Literals(['ORDER_EVIDENCE_MISSING', 'ORDER_EVIDENCE_UNAVAILABLE', 'ORDER_EVIDENCE_INDETERMINATE']),
});
export const ReservationReleaseOrderTruthSchema = Schema.Union([
  ReservationReleaseNotCommittedClosedTruthSchema,
  ReservationReleaseCommittedTruthSchema,
  ReservationReleaseNotCommittedOpenTruthSchema,
  ReservationReleaseOrderIndeterminateTruthSchema,
]);
export type ReservationReleaseOrderTruth = typeof ReservationReleaseOrderTruthSchema.Type;

export const ReservationReleaseProtectionAbsentTruthSchema = Schema.TaggedStruct('ABSENT_PROVEN', {
  evidenceRef: boundedIdentifier,
  observedAt: releaseInstant,
});
export const ReservationReleaseProtectionEstablishedTruthSchema = Schema.TaggedStruct('ESTABLISHED', {
  establishedAt: releaseInstant,
  evidenceRef: boundedIdentifier,
  observedAt: releaseInstant,
});
export const ReservationReleaseProtectionIndeterminateTruthSchema = Schema.TaggedStruct('INDETERMINATE', {
  observedAt: releaseInstant,
  reason: Schema.Literals([
    'PROTECTION_EVIDENCE_MISSING',
    'PROTECTION_EVIDENCE_UNAVAILABLE',
    'PROTECTION_EVIDENCE_INDETERMINATE',
  ]),
});
export const ReservationReleaseProtectionTruthSchema = Schema.Union([
  ReservationReleaseProtectionAbsentTruthSchema,
  ReservationReleaseProtectionEstablishedTruthSchema,
  ReservationReleaseProtectionIndeterminateTruthSchema,
]);
export type ReservationReleaseProtectionTruth = typeof ReservationReleaseProtectionTruthSchema.Type;

export const ReservationReleaseExactScopeSchema = Schema.Struct({
  allocations: ReservationAuthorityAllocationsSchema,
  attemptId: OrderCommitmentAttemptIdSchema,
  reservationId: InventoryReservationRefSchema.fields.resourceId,
  tenantId: InventoryReservationRefSchema.fields.tenantId,
});

export const ReservationReleasedBackendObservationSchema = Schema.TaggedStruct('RELEASED', {
  effectId: ReservationReleaseEffectIdSchema,
  issuer: ReservationEvidenceIssuerSchema,
  ownerEvidenceRef: boundedIdentifier,
  releasedAt: releaseInstant,
  scope: ReservationReleaseExactScopeSchema,
});
export const ReservationAlreadyReleasedBackendObservationSchema = Schema.TaggedStruct('ALREADY_RELEASED', {
  effectId: ReservationReleaseEffectIdSchema,
  issuer: ReservationEvidenceIssuerSchema,
  ownerEvidenceRef: boundedIdentifier,
  releasedAt: releaseInstant,
  scope: ReservationReleaseExactScopeSchema,
});
export const ReservationCommittedBackendObservationSchema = Schema.TaggedStruct('COMMITTED', {
  effectId: ReservationReleaseEffectIdSchema,
  evidenceRef: boundedIdentifier,
  observedAt: releaseInstant,
});
export const ReservationIndeterminateBackendObservationSchema = Schema.TaggedStruct('INDETERMINATE', {
  effectId: ReservationReleaseEffectIdSchema,
  observedAt: releaseInstant,
  reason: Schema.Literal('AUTHORITY_OUTCOME_UNKNOWN'),
});
export const ReservationReleaseBackendObservationSchema = Schema.Union([
  ReservationReleasedBackendObservationSchema,
  ReservationAlreadyReleasedBackendObservationSchema,
  ReservationCommittedBackendObservationSchema,
  ReservationIndeterminateBackendObservationSchema,
]);
export type ReservationReleaseBackendObservation = typeof ReservationReleaseBackendObservationSchema.Type;

export const RequestedReleaseEffectSchema = Schema.TaggedStruct('REQUESTED', {
  request: ReservationReleaseRequestSchema,
  revision: Schema.Literal(1),
});
export const ReleasedReservationEffectSchema = Schema.TaggedStruct('RELEASED', {
  activeAllocations: Schema.Tuple([]),
  authorityIssuer: ReservationEvidenceIssuerSchema,
  ownerEvidenceRef: boundedIdentifier,
  releasedAt: releaseInstant,
  releaseOutcome: Schema.Literals(['RELEASED', 'ALREADY_RELEASED']),
  request: ReservationReleaseRequestSchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(2)),
  safelyReusable: Schema.Literal(true),
  safeReleaseProof: Schema.Struct({
    order: Schema.TaggedStruct('NOT_COMMITTED_CLOSED', {
      closureEvidenceRef: boundedIdentifier,
      nonCommitEvidenceRef: boundedIdentifier,
      observedAt: releaseInstant,
    }),
    protection: Schema.TaggedStruct('ABSENT_PROVEN', {
      evidenceRef: boundedIdentifier,
      observedAt: releaseInstant,
    }),
  }),
});
export const NotReleasableReservationEffectSchema = Schema.TaggedStruct('NOT_RELEASABLE', {
  evidenceRef: boundedIdentifier,
  observedAt: releaseInstant,
  reason: Schema.Literals(['COMMITTED', 'PROTECTION_ESTABLISHED']),
  request: ReservationReleaseRequestSchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(2)),
  safelyReusable: Schema.Literal(false),
});
export const IndeterminateReservationReleaseEffectSchema = Schema.TaggedStruct('INDETERMINATE', {
  observedAt: releaseInstant,
  reason: Schema.Literals(['ORDER_OUTCOME_UNKNOWN', 'PROTECTION_OUTCOME_UNKNOWN', 'AUTHORITY_OUTCOME_UNKNOWN']),
  request: ReservationReleaseRequestSchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(2)),
  safelyReusable: Schema.Literal(false),
});

export const ReservationReleaseEffectSchema = Schema.Union([
  RequestedReleaseEffectSchema,
  ReleasedReservationEffectSchema,
  NotReleasableReservationEffectSchema,
  IndeterminateReservationReleaseEffectSchema,
]);
export type ReservationReleaseEffect = typeof ReservationReleaseEffectSchema.Type;

export const ReleaseInventoryReservationResultSchema = Schema.Union([
  Schema.Struct({ effect: RequestedReleaseEffectSchema, outcome: Schema.Literal('PENDING') }),
  Schema.Struct({ effect: ReleasedReservationEffectSchema, outcome: Schema.Literal('RELEASED') }),
  Schema.Struct({ effect: ReleasedReservationEffectSchema, outcome: Schema.Literal('ALREADY_RELEASED') }),
  Schema.Struct({ effect: NotReleasableReservationEffectSchema, outcome: Schema.Literal('NOT_RELEASABLE') }),
  Schema.Struct({ effect: IndeterminateReservationReleaseEffectSchema, outcome: Schema.Literal('INDETERMINATE') }),
]);
export type ReleaseInventoryReservationResult = typeof ReleaseInventoryReservationResultSchema.Type;

export class InventoryReservationReleaseRejected extends Schema.TaggedError<InventoryReservationReleaseRejected>()(
  'InventoryReservationReleaseRejected',
  {
    code: Schema.Literal('inventory_reservation_release_rejected'),
    effectId: Schema.optionalKey(ReservationReleaseEffectIdSchema),
    reason: Schema.Literals([
      'PARTIAL_RELEASE_UNSUPPORTED',
      'TENANT_SCOPE_MISMATCH',
      'RESERVATION_NOT_FOUND',
      'RESERVATION_NOT_PROVISIONAL',
      'ATTEMPT_SCOPE_MISMATCH',
      'EFFECT_ID_CONFLICT',
      'SIBLING_RELEASE_EFFECT_FORBIDDEN',
      'INVALID_BACKEND_OBSERVATION',
      'REVISION_CONFLICT',
    ]),
  },
) {}

export const ReleaseInventoryReservationErrorSchema = Schema.Union([
  InventoryReservationReleaseRejected,
  InventoryReservationReleaseUnavailable,
]);
export type InventoryReservationReleaseError = typeof ReleaseInventoryReservationErrorSchema.Type;

export { InventoryReservationReleaseUnavailable } from './inventory-reservation-release-unavailable.ts';
