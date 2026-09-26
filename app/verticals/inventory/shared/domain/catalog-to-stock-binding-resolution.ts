import { Effect, Match, Schema } from 'effect';

import {
  CatalogToStockBindingLifecycleEvidenceSchema,
  CatalogToStockBindingSchema,
} from './catalog-to-stock-binding.ts';
import type {
  CatalogToStockBinding,
  CatalogToStockBindingHistoryEntrySchema,
  CatalogToStockBindingRejected,
} from './catalog-to-stock-binding.ts';
import { CatalogBindingCorrectionRejected } from './catalog-binding-correction-rejected.ts';
import { CommittedInventoryObligationSchema } from './inventory-authority.ts';
import {
  AuthoritativeReservationEvidenceSchema,
  ReservationAuthorityAllocationSchema,
  ReservationAuthorityExactScopeSchema,
} from './reservation-authority.ts';
import type { AuthoritativeReservationEvidence, ReservationAuthorityExactScope } from './reservation-authority.ts';

const resolutionFailureReasons = [
  'MISSING_BINDING',
  'MULTIPLE_CURRENT_BINDINGS',
  'INTRINSIC_MEANING_MISMATCH',
  'STOCK_ITEM_NOT_FOUND',
  'STOCK_ITEM_NOT_CURRENT',
  'STOCK_UNIT_MISMATCH',
] as const;

export class CatalogToStockBindingResolutionFailure extends Schema.TaggedError<CatalogToStockBindingResolutionFailure>()(
  'CatalogToStockBindingResolutionFailure',
  {
    bindingRef: Schema.optionalKey(CatalogToStockBindingSchema.fields.bindingRef),
    code: Schema.Literal('catalog_to_stock_binding_resolution_failure'),
    outcome: Schema.Literals(['MISSING', 'CONFLICTING', 'INCOMPATIBLE']),
    reason: Schema.Literals(resolutionFailureReasons),
    stockItemRef: Schema.optionalKey(CatalogToStockBindingSchema.fields.stockItemRef),
  },
) {}

const resolutionOutcomeFor = (
  reason: (typeof resolutionFailureReasons)[number],
): CatalogToStockBindingResolutionFailure['outcome'] => {
  if (reason === 'MULTIPLE_CURRENT_BINDINGS') {
    return 'CONFLICTING';
  }
  if (reason === 'INTRINSIC_MEANING_MISMATCH' || reason === 'STOCK_UNIT_MISMATCH') {
    return 'INCOMPATIBLE';
  }
  return 'MISSING';
};

const failResolution = (failure: CatalogToStockBindingRejected, reason: (typeof resolutionFailureReasons)[number]) => {
  const fields = {
    code: 'catalog_to_stock_binding_resolution_failure' as const,
    outcome: resolutionOutcomeFor(reason),
    reason,
  };
  if (failure.bindingRef !== undefined && failure.stockItemRef !== undefined) {
    return Effect.fail(
      new CatalogToStockBindingResolutionFailure({
        ...fields,
        bindingRef: failure.bindingRef,
        stockItemRef: failure.stockItemRef,
      }),
    );
  }
  if (failure.bindingRef !== undefined) {
    return Effect.fail(new CatalogToStockBindingResolutionFailure({ ...fields, bindingRef: failure.bindingRef }));
  }
  if (failure.stockItemRef !== undefined) {
    return Effect.fail(new CatalogToStockBindingResolutionFailure({ ...fields, stockItemRef: failure.stockItemRef }));
  }
  return Effect.fail(new CatalogToStockBindingResolutionFailure(fields));
};

/**
 * Presents #827's closed binding-resolution vocabulary while retaining #822's
 * exact diagnostic reason. A non-success stays in Effect's failure channel and
 * can never be mistaken for resolved stock demand or Stock Evidence state.
 */
export const failCatalogToStockBindingResolution = (failure: CatalogToStockBindingRejected) =>
  Match.value(failure.reason).pipe(
    Match.whenOr(
      'INTRINSIC_MEANING_MISMATCH',
      'MISSING_BINDING',
      'MULTIPLE_CURRENT_BINDINGS',
      'STOCK_ITEM_NOT_CURRENT',
      'STOCK_ITEM_NOT_FOUND',
      'STOCK_UNIT_MISMATCH',
      (reason) => failResolution(failure, reason),
    ),
    Match.whenOr(
      'BINDING_ID_CONFLICT',
      'REPLACEMENT_MATCHES_CURRENT_TARGET',
      'REVISION_CONFLICT',
      'SELECTION_MEANING_ALREADY_BOUND',
      'STOCK_ITEM_ALREADY_BOUND',
      'TRANSITION_TIME_NOT_AFTER_CURRENT',
      () => Effect.die(failure),
    ),
    Match.exhaustive,
  );

const affectedAllocationIdsSchema = Schema.Array(ReservationAuthorityAllocationSchema.fields.allocationId).check(
  Schema.isMinLength(1),
  Schema.makeFilter((identifiers) =>
    new Set(identifiers).size === identifiers.length ? undefined : 'Affected Allocation identities must be unique',
  ),
);

const correctionObligationBase = {
  affectedAllocationIds: affectedAllocationIdsSchema,
  reservation: ReservationAuthorityExactScopeSchema,
} as const;

export const CatalogBindingAffectedObligationSchema = Schema.Union([
  Schema.Struct({
    ...correctionObligationBase,
    confirmation: AuthoritativeReservationEvidenceSchema,
    stage: Schema.Literal('BEFORE_PROTECTION'),
  }),
  Schema.Struct({
    ...correctionObligationBase,
    confirmation: AuthoritativeReservationEvidenceSchema,
    protection: AuthoritativeReservationEvidenceSchema,
    stage: Schema.Literal('PROTECTED'),
  }),
  Schema.Struct({
    ...correctionObligationBase,
    committedObligation: CommittedInventoryObligationSchema,
    protection: AuthoritativeReservationEvidenceSchema,
    stage: Schema.Literal('COMMITTED'),
  }),
]);
export type CatalogBindingAffectedObligation = typeof CatalogBindingAffectedObligationSchema.Type;

export const CatalogBindingCorrectionInputSchema = Schema.Struct({
  correctedBinding: CatalogToStockBindingSchema,
  correctionEvidence: CatalogToStockBindingLifecycleEvidenceSchema,
  obligations: Schema.Array(CatalogBindingAffectedObligationSchema),
  previousBinding: CatalogToStockBindingSchema,
});
export type CatalogBindingCorrectionInput = typeof CatalogBindingCorrectionInputSchema.Type;

const rejectedCorrection = (reason: CatalogBindingCorrectionRejected['reason']) =>
  new CatalogBindingCorrectionRejected({ code: 'catalog_binding_correction_rejected', reason });

interface ResourceIdentity {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}

const sameResource = (left: ResourceIdentity, right: ResourceIdentity): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sameMeaning = (left: CatalogToStockBinding, right: CatalogToStockBinding): boolean =>
  left.exactSelectionMeaning.id === right.exactSelectionMeaning.id &&
  left.exactSelectionMeaning.kind === right.exactSelectionMeaning.kind;

type ReservationAllocation = ReservationAuthorityExactScope['allocations'][number];

const sameAllocation = (left: ReservationAllocation, right: ReservationAllocation): boolean =>
  left.allocationId === right.allocationId &&
  left.quantity.amount === right.quantity.amount &&
  sameResource(left.quantity.unitRef, right.quantity.unitRef) &&
  sameResource(left.stockItemRef, right.stockItemRef) &&
  sameResource(left.stockPositionRef, right.stockPositionRef);

const sameAllocations = (
  left: ReservationAuthorityExactScope['allocations'],
  right: ReservationAuthorityExactScope['allocations'],
): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  const rightById = new Map(right.map((allocation) => [allocation.allocationId, allocation] as const));
  return left.every((allocation) => {
    const candidate = rightById.get(allocation.allocationId);
    return candidate !== undefined && sameAllocation(allocation, candidate);
  });
};

const sameProofScope = (
  evidence: AuthoritativeReservationEvidence,
  reservation: ReservationAuthorityExactScope,
): boolean =>
  evidence.evidence.tenantId === reservation.tenantId &&
  evidence.evidence.attemptId === reservation.attemptId &&
  evidence.evidence.reservationId === reservation.reservationId &&
  sameAllocations(evidence.evidence.allocations, reservation.allocations);

const validateCorrectionTransition = ({
  correctedBinding,
  previousBinding,
}: CatalogBindingCorrectionInput): Effect.Effect<void, CatalogBindingCorrectionRejected> =>
  sameResource(previousBinding.bindingRef, correctedBinding.bindingRef) &&
  sameMeaning(previousBinding, correctedBinding) &&
  sameResource(previousBinding.unitRef, correctedBinding.unitRef) &&
  correctedBinding.revision === previousBinding.revision + 1 &&
  !sameResource(previousBinding.stockItemRef, correctedBinding.stockItemRef)
    ? Effect.void
    : Effect.fail(rejectedCorrection('INVALID_CORRECTION_TRANSITION'));

const validateObligation = (
  previousBinding: CatalogToStockBinding,
  obligation: CatalogBindingAffectedObligation,
): Effect.Effect<void, CatalogBindingCorrectionRejected> => {
  const allocationsById = new Map(
    obligation.reservation.allocations.map((allocation) => [allocation.allocationId, allocation] as const),
  );
  for (const allocationId of obligation.affectedAllocationIds) {
    const allocation = allocationsById.get(allocationId);
    if (allocation === undefined) {
      return Effect.fail(rejectedCorrection('AFFECTED_ALLOCATION_NOT_FOUND'));
    }
    if (!sameResource(allocation.stockItemRef, previousBinding.stockItemRef)) {
      return Effect.fail(rejectedCorrection('AFFECTED_ALLOCATION_LINEAGE_MISMATCH'));
    }
  }

  if (
    obligation.stage !== 'COMMITTED' &&
    (obligation.confirmation.operation !== 'RESERVATION_CONFIRMATION' ||
      !sameProofScope(obligation.confirmation, obligation.reservation))
  ) {
    return Effect.fail(rejectedCorrection('CONFIRMATION_SCOPE_MISMATCH'));
  }
  if (
    obligation.stage !== 'BEFORE_PROTECTION' &&
    (obligation.protection.operation !== 'COMMITMENT_PROTECTION' ||
      !sameProofScope(obligation.protection, obligation.reservation))
  ) {
    return Effect.fail(rejectedCorrection('PROTECTION_SCOPE_MISMATCH'));
  }
  if (
    obligation.stage === 'COMMITTED' &&
    (obligation.committedObligation.attemptId !== obligation.reservation.attemptId ||
      obligation.committedObligation.reservationObligationId !== obligation.reservation.reservationId)
  ) {
    return Effect.fail(rejectedCorrection('COMMITTED_SCOPE_MISMATCH'));
  }
  return Effect.void;
};

const consequenceFor = (obligation: CatalogBindingAffectedObligation) => {
  const preserved = {
    affectedAllocationIds: obligation.affectedAllocationIds,
    confirmationState: 'AT_RISK' as const,
    orderRolledBack: false as const,
    preservedReservation: obligation.reservation,
    reconciliation: 'REQUIRED' as const,
    reservationReleased: false as const,
    reservationRevoked: false as const,
    retargeted: false as const,
    stage: obligation.stage,
  };
  if (obligation.stage === 'BEFORE_PROTECTION') {
    return {
      ...preserved,
      confirmation: obligation.confirmation,
      newProtectionAllowed: false as const,
    };
  }
  if (obligation.stage === 'PROTECTED') {
    return {
      ...preserved,
      confirmation: obligation.confirmation,
      preservedProtection: obligation.protection,
    };
  }
  return {
    ...preserved,
    committedObligation: obligation.committedObligation,
    exception: 'POST_COMMIT_BINDING_MISMATCH' as const,
    preservedProtection: obligation.protection,
  };
};

/**
 * Derives correction consequences without mutating a Reservation, Protection,
 * Accepted Order, or their exact Stock Item lineage. Applying the relation
 * correction changes future resolution only; every existing obligation stays
 * fenced to the Stock Item actually used when it was established.
 */
export const assessCatalogBindingCorrection = (
  input: CatalogBindingCorrectionInput,
): Effect.Effect<
  {
    readonly consequences: readonly ReturnType<typeof consequenceFor>[];
    readonly futureResolution: {
      readonly bindingRef: CatalogToStockBinding['bindingRef'];
      readonly revision: CatalogToStockBinding['revision'];
      readonly stockItemRef: CatalogToStockBinding['stockItemRef'];
    };
    readonly historyEntry: typeof CatalogToStockBindingHistoryEntrySchema.Type;
  },
  CatalogBindingCorrectionRejected
> =>
  validateCorrectionTransition(input).pipe(
    Effect.flatMap(() =>
      Effect.forEach(
        input.obligations,
        (obligation) =>
          validateObligation(input.previousBinding, obligation).pipe(Effect.as(consequenceFor(obligation))),
        { concurrency: 1 },
      ),
    ),
    Effect.map((consequences) => ({
      consequences,
      futureResolution: {
        bindingRef: input.correctedBinding.bindingRef,
        revision: input.correctedBinding.revision,
        stockItemRef: input.correctedBinding.stockItemRef,
      },
      historyEntry: {
        binding: input.previousBinding,
        endedAt: input.correctedBinding.effectiveFrom,
        ownerEvidenceRef: input.correctionEvidence.ownerEvidenceRef,
        transition: 'CORRECTED',
      },
    })),
  );

export { CatalogBindingCorrectionRejected } from './catalog-binding-correction-rejected.ts';
