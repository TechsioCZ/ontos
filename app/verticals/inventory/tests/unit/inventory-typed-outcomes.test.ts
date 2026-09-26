import { ActionPermissionDenied } from '@app/core-runtime';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CatalogToStockBindingResolutionFailure } from '../../shared/domain/catalog-to-stock-binding-resolution.ts';
import { InventoryBackendIdSchema } from '../../shared/domain/inventory-backend-identifiers.ts';
import { InventoryReservationGuaranteeUnsupported } from '../../shared/domain/inventory-reservation-guarantee-unsupported.ts';
import { InventoryReservationCreateRejected } from '../../shared/domain/inventory-reservation-create.ts';
import { ReservationAuthorityUnavailable } from '../../shared/domain/reservation-authority-unavailable.ts';
import { ReservationEffectIndeterminate } from '../../shared/domain/reservation-effect-indeterminate.ts';
import { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import {
  CatalogBindingCapabilityOutcomeSchema,
  InventoryCommittedObligationCapabilityOutcomeSchema,
  InventoryCommitmentProtectionCapabilityOutcomeSchema,
  InventoryReservationDemandInputOutcomeSchema,
  InventoryReservationCreateCapabilityOutcomeSchema,
  InventoryStockEvidenceCapabilityOutcomeSchema,
  InventoryUnresolvedReservationEffectConstraintOutcomeSchema,
  KnownInsufficientConstrainedStockSchema,
  inventoryBackendSelectionNextStep,
  inventoryBindingResolutionNextStep,
  inventoryCommitmentProtectionNextStep,
  inventoryCommittedObligationNextStep,
  inventoryPreCommitCompensationNextStep,
  inventoryReservationConfirmationNextStep,
  inventoryReservationCreateNextStep,
  inventoryReservationDemandInputNextStep,
  inventoryReservationReleaseNextStep,
  inventoryReservationShortageNextStep,
  inventorySourceCoverageNextStep,
  inventoryStockEvidenceNextStep,
  inventoryUnresolvedReservationEffectConstraintNextStep,
} from '../../shared/domain/inventory-typed-outcomes.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const effectId = ReservationAuthorityEffectIdSchema.make('22222222-2222-4222-8222-222222222222');
const backendId = InventoryBackendIdSchema.make('backend-a');
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const positionRef = {
  moduleId: 'commerce.inventory' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.inventory.stock-position' as const,
  tenantId,
};
const ownerConfigurationRef = {
  moduleId: 'commerce.inventory' as const,
  resourceId: 'backend-configuration-1',
  resourceType: 'commerce.inventory.inventory-backend-configuration' as const,
  tenantId,
};

describe('Inventory capability-scoped typed outcomes', () => {
  it('keeps Binding MISSING distinct from Stock Evidence MISSING', () => {
    const bindingMissing = new CatalogToStockBindingResolutionFailure({
      code: 'catalog_to_stock_binding_resolution_failure',
      outcome: 'MISSING',
      reason: 'MISSING_BINDING',
    });
    const stockMissing = {
      _tag: 'MISSING' as const,
      meaning: 'ON_HAND' as const,
      ownerConfigurationRef,
      unitRef,
    };

    expect(Schema.is(CatalogBindingCapabilityOutcomeSchema)(bindingMissing)).toBe(true);
    expect(Schema.is(InventoryStockEvidenceCapabilityOutcomeSchema)(bindingMissing)).toBe(false);
    expect(Schema.is(InventoryStockEvidenceCapabilityOutcomeSchema)(stockMissing)).toBe(true);
    expect(inventoryBindingResolutionNextStep(bindingMissing.outcome)).toBe('REPAIR_BINDING');
    expect(inventoryStockEvidenceNextStep(stockMissing._tag)).toBe('ACQUIRE_OWNER_EVIDENCE');
  });

  it('accepts only proven exact constrained insufficiency in one unchanged Unit', () => {
    const insufficient = {
      _tag: 'INSUFFICIENT' as const,
      availableQuantity: { amount: '2', unitRef },
      positionRef,
      requestedQuantity: { amount: '3', unitRef },
    };
    const enough = {
      ...insufficient,
      availableQuantity: { amount: '3', unitRef },
    };
    const otherUnit = {
      ...insufficient,
      requestedQuantity: {
        amount: '3',
        unitRef: { ...unitRef, resourceId: '55555555-5555-4555-8555-555555555555' },
      },
    };

    expect(Schema.is(KnownInsufficientConstrainedStockSchema)(insufficient)).toBe(true);
    expect(Schema.is(KnownInsufficientConstrainedStockSchema)(enough)).toBe(false);
    expect(Schema.is(KnownInsufficientConstrainedStockSchema)(otherUnit)).toBe(false);
    expect(inventoryStockEvidenceNextStep(insufficient._tag)).toBe('STOP');
  });

  it('keeps invalid Quantity and incompatible Unit as typed input repair outcomes', () => {
    const invalidQuantity = {
      _tag: 'REJECTED' as const,
      purchaseDemandOccurrenceId: 'demand-occurrence-1',
      reason: 'INVALID_REQUESTED_QUANTITY' as const,
    };
    const incompatibleUnit = {
      ...invalidQuantity,
      reason: 'INCOMPATIBLE_REQUESTED_UNIT' as const,
    };

    expect(Schema.is(InventoryReservationDemandInputOutcomeSchema)(invalidQuantity)).toBe(true);
    expect(Schema.is(InventoryReservationDemandInputOutcomeSchema)(incompatibleUnit)).toBe(true);
    expect(inventoryReservationDemandInputNextStep(invalidQuantity._tag)).toBe('REPAIR_INPUT');
  });

  it('keeps create rejection, unsupported capability, unavailable owner, indeterminate effect, and permission denial distinct', () => {
    const unsupported = new InventoryReservationGuaranteeUnsupported({
      code: 'inventory_reservation_guarantee_unsupported',
      fallbackApplied: false,
      proofIssued: false,
      reason: 'selected_backend_does_not_support_required_guarantee',
      selectedBackendId: backendId,
    });
    const unavailable = new ReservationAuthorityUnavailable({
      effectAbsenceProven: false,
      fallbackApplied: false,
      originalEffectId: effectId,
      proofIssued: false,
      reason: 'SELECTED_RESERVATION_AUTHORITY_UNAVAILABLE',
      recovery: 'VERIFY_OR_RECOVER_ORIGINAL_EFFECT',
      selectedBackend: 'external_business_system',
      selectedBackendId: backendId,
    });
    const indeterminate = new ReservationEffectIndeterminate({
      competingFreshEffectAllowed: false,
      fallbackApplied: false,
      originalEffectId: effectId,
      proofIssued: false,
      reason: 'RESERVATION_EFFECT_INDETERMINATE',
      recovery: 'RECOVER_ORIGINAL_EFFECT',
      selectedBackend: 'external_business_system',
      selectedBackendId: backendId,
    });
    const denied = new ActionPermissionDenied({ code: 'action_permission_denied', reason: 'permission denied' });

    for (const outcome of [unsupported, unavailable, indeterminate, denied]) {
      expect(Schema.is(InventoryReservationCreateCapabilityOutcomeSchema)(outcome)).toBe(true);
    }
    expect(Schema.is(InventoryCommitmentProtectionCapabilityOutcomeSchema)(unsupported)).toBe(false);
    expect(inventoryReservationCreateNextStep(unsupported)).toBe('STOP');
    expect(inventoryReservationCreateNextStep(unavailable)).toBe('WAIT_FOR_OWNER');
    expect(inventoryReservationCreateNextStep(indeterminate)).toBe('RECOVER_ORIGINAL_EFFECT');
    expect(inventoryReservationCreateNextStep(denied)).toBe('STOP');
  });

  it('keeps an owner-scoped idempotency conflict distinct from exact replay', () => {
    const conflict = new InventoryReservationCreateRejected({
      code: 'inventory_reservation_create_rejected',
      effectId,
      reason: 'EFFECT_ID_CONFLICT',
    });

    expect(Schema.is(InventoryReservationCreateCapabilityOutcomeSchema)(conflict)).toBe(true);
    expect(inventoryReservationCreateNextStep(conflict)).toBe('STOP_CONFLICT');
    expect(inventoryReservationCreateNextStep({ outcome: 'EXACT_REPLAY' })).toBe('CONTINUE');
  });

  it('gives each Reservation create result a safe next step without treating partial or unknown effects as success', () => {
    expect(inventoryReservationCreateNextStep({ outcome: 'ESTABLISHED' })).toBe('CONTINUE');
    expect(inventoryReservationCreateNextStep({ outcome: 'EXACT_REPLAY' })).toBe('CONTINUE');
    expect(inventoryReservationCreateNextStep({ outcome: 'PENDING' })).toBe('RECOVER_ORIGINAL_EFFECT');
    expect(inventoryReservationCreateNextStep({ outcome: 'INDETERMINATE' })).toBe('RECOVER_ORIGINAL_EFFECT');
    expect(inventoryReservationCreateNextStep({ outcome: 'RECONCILIATION_REQUIRED' })).toBe('RECONCILE');
    expect(inventoryReservationCreateNextStep({ outcome: 'RESOLVED_NO_RESERVATION' })).toBe('STOP');
  });

  it('keeps Confirmation proof health distinct from Release and preserves recovery semantics', () => {
    expect(inventoryReservationConfirmationNextStep('VALID')).toBe('CONTINUE_TO_PROTECTION');
    expect(inventoryReservationConfirmationNextStep('AT_RISK')).toBe('RECONCILE');
    expect(inventoryReservationConfirmationNextStep('UNVERIFIABLE')).toBe('ACQUIRE_OWNER_EVIDENCE');
    expect(inventoryReservationConfirmationNextStep('REVOKED')).toBe('STOP');
    expect(inventoryReservationConfirmationNextStep('EXPIRED')).toBe('STOP');
  });

  it('distinguishes protected, at-risk, indeterminate, rejected, conflict, and unavailable protection outcomes', () => {
    expect(inventoryCommitmentProtectionNextStep({ _tag: 'PROTECTED' })).toBe('CONTINUE');
    expect(inventoryCommitmentProtectionNextStep({ _tag: 'AT_RISK' })).toBe('RECONCILE');
    expect(inventoryCommitmentProtectionNextStep({ _tag: 'INDETERMINATE' })).toBe('RECOVER_ORIGINAL_EFFECT');
    expect(inventoryCommitmentProtectionNextStep({ _tag: 'NOT_PROTECTABLE' })).toBe('STOP');
    expect(inventoryCommitmentProtectionNextStep({ _tag: 'CommitmentProtectionConflict' })).toBe('STOP_CONFLICT');
    expect(inventoryCommitmentProtectionNextStep({ _tag: 'CommitmentProtectionUnavailable' })).toBe('WAIT_FOR_OWNER');
  });

  it('allows only proven whole Release to make stock reusable', () => {
    expect(inventoryReservationReleaseNextStep({ outcome: 'RELEASED' })).toBe('CONTINUE');
    expect(inventoryReservationReleaseNextStep({ outcome: 'ALREADY_RELEASED' })).toBe('CONTINUE');
    expect(inventoryReservationReleaseNextStep({ outcome: 'PENDING' })).toBe('RECOVER_ORIGINAL_EFFECT');
    expect(inventoryReservationReleaseNextStep({ outcome: 'INDETERMINATE' })).toBe('RECOVER_ORIGINAL_EFFECT');
    expect(inventoryReservationReleaseNextStep({ outcome: 'NOT_RELEASABLE' })).toBe('STOP');
  });

  it('exposes closure wait, reconciliation, and safe compensation as different next steps', () => {
    expect(inventoryPreCommitCompensationNextStep({ outcome: 'CREATE_EFFECT_COMPENSATED' })).toBe('CONTINUE');
    expect(inventoryPreCommitCompensationNextStep({ outcome: 'ALREADY_COMPENSATED' })).toBe('CONTINUE');
    expect(inventoryPreCommitCompensationNextStep({ outcome: 'NO_COMPENSATION_REQUIRED' })).toBe('CONTINUE');
    expect(inventoryPreCommitCompensationNextStep({ outcome: 'RECONCILIATION_REQUIRED' })).toBe('RECONCILE');
    expect(
      inventoryPreCommitCompensationNextStep({
        outcome: 'RESERVATION_RELEASE',
        release: { outcome: 'INDETERMINATE' },
      }),
    ).toBe('RECOVER_ORIGINAL_EFFECT');
    expect(inventoryPreCommitCompensationNextStep({ outcome: 'BLOCKED', reason: 'ATTEMPT_NOT_CLOSED' })).toBe(
      'WAIT_FOR_CLOSURE',
    );
    expect(inventoryPreCommitCompensationNextStep({ outcome: 'BLOCKED', reason: 'ORDER_TRUTH_UNKNOWN' })).toBe(
      'ACQUIRE_OWNER_EVIDENCE',
    );
  });

  it('keeps source coverage, shortage ordering, and backend configuration uncertainty capability-scoped', () => {
    expect(inventorySourceCoverageNextStep('DETERMINATE')).toBe('CONTINUE');
    expect(inventorySourceCoverageNextStep('HISTORICAL')).toBe('STOP');
    expect(inventorySourceCoverageNextStep('INDETERMINATE')).toBe('RECONCILE');
    expect(inventoryReservationShortageNextStep({ _tag: 'DETERMINATE', decisions: [] })).toBe('CONTINUE');
    expect(
      inventoryReservationShortageNextStep({
        _tag: 'DETERMINATE',
        decisions: [{ capacity: 'HONORABLE' }, { capacity: 'SHORTAGE' }],
      }),
    ).toBe('STOP');
    expect(inventoryReservationShortageNextStep({ _tag: 'INDETERMINATE' })).toBe('RECONCILE');
    expect(inventoryBackendSelectionNextStep('SELECTED')).toBe('CONTINUE');
    expect(inventoryBackendSelectionNextStep('EXACT_REPLAY')).toBe('CONTINUE');
    expect(inventoryBackendSelectionNextStep('BACKEND_CONFIGURATION_CONFLICT')).toBe('REPAIR_CONFIGURATION');
  });

  it('does not collapse a committed obligation into its post-commit reconciliation state', () => {
    expect(inventoryCommittedObligationNextStep('COMMITTED_OBLIGATION')).toBe('CONTINUE');
    expect(inventoryCommittedObligationNextStep('POST_COMMIT_RECONCILIATION')).toBe('RECONCILE');
    expect(
      Schema.is(InventoryCommittedObligationCapabilityOutcomeSchema)({
        _tag: 'POST_COMMIT_RECONCILIATION',
        obligation: { lifecycleMeaning: 'COMMITTED_OBLIGATION' },
        reason: 'POST_COMMIT_BINDING_MISMATCH',
        reconciliationRequired: true,
      }),
    ).toBe(false);
  });

  it('keeps exact partial holds and uncertain constraints attached to the original effect recovery path', () => {
    expect(inventoryUnresolvedReservationEffectConstraintNextStep('EXACT')).toBe('EVALUATE_COMPENSATION');
    expect(inventoryUnresolvedReservationEffectConstraintNextStep('INDETERMINATE')).toBe('ACQUIRE_OWNER_EVIDENCE');
    expect(Schema.is(InventoryUnresolvedReservationEffectConstraintOutcomeSchema)({ _tag: 'EXACT' })).toBe(false);
  });
});
