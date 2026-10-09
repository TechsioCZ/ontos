import { DateTime, Effect } from 'effect';

import {
  ReservationAuthorityUnavailable,
  ReservationEffectIndeterminate,
  ReservationIssuerEvidenceRejected,
} from '../../shared/domain/reservation-authority.ts';
import type {
  AuthoritativeReservationEvidence,
  ReservationAuthorityAllocation,
  ReservationAuthorityIssueRequest,
  ReservationAuthorityObservation,
} from '../../shared/domain/reservation-authority.ts';
import { dispatchReservationAuthority } from '../../shared/domain/inventory-backend-configuration.ts';
import type { InventoryReservationAuthorityDispatch } from '../../shared/domain/inventory-backend-configuration.ts';
import { InventoryReservationGuaranteeUnsupported } from '../../shared/domain/inventory-reservation-guarantee-unsupported.ts';
import { resolveInventoryOwnerEvidence } from '../../shared/domain/inventory-authority.ts';
import type { InventoryAuthorityDecisionRejected } from '../../shared/domain/inventory-authority.ts';
import type { InventoryLaunchCutlineRejected } from '../../shared/inventory-launch-scope.ts';

type ReservationAuthorityIssueCommand = ReservationAuthorityIssueRequest & InventoryReservationAuthorityDispatch;

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- Owner-private backend adapters are supplied directly to this owner-local domain service.
export interface ReservationAuthorityIssuerPort {
  readonly issue: (command: ReservationAuthorityIssueCommand) => Effect.Effect<ReservationAuthorityObservation>;
}

export type ReservationIssuerFailure =
  | InventoryAuthorityDecisionRejected
  | InventoryLaunchCutlineRejected
  | InventoryReservationGuaranteeUnsupported
  | ReservationAuthorityUnavailable
  | ReservationEffectIndeterminate
  | ReservationIssuerEvidenceRejected;

const sameUnitRef = (
  left: ReservationAuthorityAllocation['quantity']['unitRef'],
  right: ReservationAuthorityAllocation['quantity']['unitRef'],
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sameAllocation = (left: ReservationAuthorityAllocation, right: ReservationAuthorityAllocation): boolean =>
  left.allocationId === right.allocationId &&
  left.quantity.amount === right.quantity.amount &&
  sameUnitRef(left.quantity.unitRef, right.quantity.unitRef) &&
  left.stockItemRef.moduleId === right.stockItemRef.moduleId &&
  left.stockItemRef.resourceId === right.stockItemRef.resourceId &&
  left.stockItemRef.resourceType === right.stockItemRef.resourceType &&
  left.stockItemRef.tenantId === right.stockItemRef.tenantId &&
  left.stockPositionRef.moduleId === right.stockPositionRef.moduleId &&
  left.stockPositionRef.resourceId === right.stockPositionRef.resourceId &&
  left.stockPositionRef.resourceType === right.stockPositionRef.resourceType &&
  left.stockPositionRef.tenantId === right.stockPositionRef.tenantId;

const sameAllocations = (
  left: readonly ReservationAuthorityAllocation[],
  right: readonly ReservationAuthorityAllocation[],
): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  const matchedRightIndexes = new Set<number>();
  return left.every((allocation) => {
    const matchingIndex = right.findIndex(
      (candidate, index) => !matchedRightIndexes.has(index) && sameAllocation(allocation, candidate),
    );
    if (matchingIndex === -1) {
      return false;
    }
    matchedRightIndexes.add(matchingIndex);
    return true;
  });
};

const rejectionFor = (request: ReservationAuthorityIssueRequest, reason: ReservationIssuerEvidenceRejected['reason']) =>
  new ReservationIssuerEvidenceRejected({
    fallbackApplied: false,
    originalEffectId: request.effectId,
    proofIssued: false,
    reason,
    selectedBackend: request.configuration.selection.backend,
    selectedBackendId: request.configuration.selection.backendId,
  });

const expectedOrigin = (
  backend: ReservationAuthorityIssueRequest['configuration']['selection']['backend'],
): 'EXTERNAL_BUSINESS_SYSTEM' | 'ONTOS_WMS' =>
  backend === 'external_business_system' ? 'EXTERNAL_BUSINESS_SYSTEM' : 'ONTOS_WMS';

const evidenceMatchesRequest = (
  request: ReservationAuthorityIssueRequest,
  observation: Extract<ReservationAuthorityObservation, { kind: 'CONFIRMED' }>,
): boolean =>
  observation.evidence.tenantId === request.reservation.tenantId &&
  observation.evidence.customerConfigurationId === request.configuration.customerConfigurationId &&
  observation.evidence.attemptId === request.reservation.attemptId &&
  observation.evidence.reservationId === request.reservation.reservationId &&
  sameAllocations(observation.evidence.allocations, request.reservation.allocations);

export const makeReservationIssuerService = (port: ReservationAuthorityIssuerPort) => {
  const issue = Effect.fn('ReservationIssuerService.issue')(function* issueReservationEvidence(
    request: ReservationAuthorityIssueRequest,
  ): Effect.fn.Return<AuthoritativeReservationEvidence, ReservationIssuerFailure> {
    const dispatch = yield* dispatchReservationAuthority(request.configuration);
    const observation = yield* port.issue({ ...request, ...dispatch });

    if (observation.effectId !== request.effectId) {
      return yield* rejectionFor(request, 'EFFECT_IDENTITY_MISMATCH');
    }

    if (observation.kind === 'UNSUPPORTED') {
      return yield* new InventoryReservationGuaranteeUnsupported({
        code: 'inventory_reservation_guarantee_unsupported',
        fallbackApplied: false,
        proofIssued: false,
        reason: 'selected_backend_does_not_support_required_guarantee',
        selectedBackendId: request.configuration.selection.backendId,
      });
    }

    if (observation.kind === 'UNAVAILABLE') {
      return yield* new ReservationAuthorityUnavailable({
        effectAbsenceProven: false,
        fallbackApplied: false,
        originalEffectId: observation.effectId,
        proofIssued: false,
        reason: 'SELECTED_RESERVATION_AUTHORITY_UNAVAILABLE',
        recovery: 'VERIFY_OR_RECOVER_ORIGINAL_EFFECT',
        selectedBackend: request.configuration.selection.backend,
        selectedBackendId: request.configuration.selection.backendId,
      });
    }

    if (observation.kind === 'INDETERMINATE') {
      return yield* new ReservationEffectIndeterminate({
        competingFreshEffectAllowed: false,
        fallbackApplied: false,
        originalEffectId: observation.effectId,
        proofIssued: false,
        reason: 'RESERVATION_EFFECT_INDETERMINATE',
        recovery: 'RECOVER_ORIGINAL_EFFECT',
        selectedBackend: request.configuration.selection.backend,
        selectedBackendId: request.configuration.selection.backendId,
      });
    }

    if (observation.operation !== request.operation) {
      return yield* rejectionFor(request, 'OPERATION_MISMATCH');
    }
    if (
      observation.issuer.backend !== request.configuration.selection.backend ||
      observation.issuer.backendId !== request.configuration.selection.backendId ||
      observation.issuer.origin !== expectedOrigin(request.configuration.selection.backend)
    ) {
      return yield* rejectionFor(request, 'ISSUER_IDENTITY_MISMATCH');
    }
    if (!evidenceMatchesRequest(request, observation)) {
      return yield* rejectionFor(request, 'EXACT_RESERVATION_SCOPE_MISMATCH');
    }
    if (
      DateTime.toEpochMillis(DateTime.makeUnsafe(observation.evidence.validUntil)) <=
      DateTime.toEpochMillis(DateTime.makeUnsafe(observation.evidence.validFrom))
    ) {
      return yield* rejectionFor(request, 'INVALID_PROOF_VALIDITY');
    }

    yield* resolveInventoryOwnerEvidence({
      authority: dispatch.authority,
      observation: {
        issuer: { backend: observation.issuer.backend, kind: 'INVENTORY_BACKEND' },
        kind: 'CONFIRMED',
        ownerEvidenceRef: observation.evidence.ownerEvidenceRef,
        verification: 'OWNER_VERIFIED',
      },
      operation: observation.operation,
    });

    return {
      effectId: observation.effectId,
      evidence: observation.evidence,
      issuer: observation.issuer,
      kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
      operation: observation.operation,
    };
  });

  return Object.freeze({ issue });
};
