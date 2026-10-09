import { Effect, Match, Option, Schema } from 'effect';

import {
  CurrentStockEvidenceForAvailabilityRejected,
  InventoryStockEvidenceForAvailabilitySchema,
} from '../../shared/domain/current-stock-evidence-for-availability.ts';
import type {
  CurrentStockEvidenceForAvailabilityUnavailable,
  InventoryStockEvidenceForAvailability,
  ReservationCreateEffectForAvailability,
  StockSourceEvidenceForAvailability,
  UnresolvedReservationEffectConstraint,
} from '../../shared/domain/current-stock-evidence-for-availability.ts';
import type { CatalogToStockBinding } from '../../shared/domain/catalog-to-stock-binding.ts';
import type { InventoryBackendConfiguration } from '../../shared/domain/inventory-backend-configuration.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import type { InventoryObligation } from '../../shared/domain/inventory-obligation.ts';
import type { InventorySourceAssertion } from '../../shared/domain/inventory-source-assertion.ts';
import type { PhysicalStockEffectRecord } from '../../shared/domain/physical-stock-effect.ts';
import type {
  CurrentSuccessfulAllocationQuantity,
  StockPosition,
  StockPositionReservedEvidence,
} from '../../shared/domain/stock-position.ts';
import { deriveReservedQuantity } from '../../shared/domain/stock-position.ts';
import type { StockItem } from '../../shared/domain/stock-item.ts';
import { ActiveLifecycleSchema } from '../../shared/domain/stock-location.ts';
import type { StockLocation } from '../../shared/domain/stock-location.ts';
import type { StockPositionRef } from '../../shared/resources/stock-position.ts';
import { evaluateInventorySourceAssertionCoverage } from '../domain/inventory-source-assertion-evaluator.ts';

type EvidenceFailure = CurrentStockEvidenceForAvailabilityRejected | CurrentStockEvidenceForAvailabilityUnavailable;

export interface CurrentStockEvidenceForAvailabilityDependencies {
  readonly findAuthority: (
    customerConfigurationId: string,
  ) => Effect.Effect<Option.Option<InventoryBackendConfiguration>, CurrentStockEvidenceForAvailabilityUnavailable>;
  readonly findBinding: (
    position: StockPosition,
  ) => Effect.Effect<Option.Option<CatalogToStockBinding>, CurrentStockEvidenceForAvailabilityUnavailable>;
  readonly findStockItem: (
    position: StockPosition,
  ) => Effect.Effect<Option.Option<StockItem>, CurrentStockEvidenceForAvailabilityUnavailable>;
  readonly findStockLocation: (
    position: StockPosition,
  ) => Effect.Effect<Option.Option<StockLocation>, CurrentStockEvidenceForAvailabilityUnavailable>;
  readonly listCommittedObligations: (
    positionRef: StockPositionRef,
  ) => Effect.Effect<readonly InventoryObligation[], CurrentStockEvidenceForAvailabilityUnavailable>;
  readonly listCurrentSuccessfulAllocations: (
    positionRef: StockPositionRef,
  ) => Effect.Effect<readonly CurrentSuccessfulAllocationQuantity[], CurrentStockEvidenceForAvailabilityUnavailable>;
  readonly listMaterialEffects: (
    positionRef: StockPositionRef,
  ) => Effect.Effect<readonly PhysicalStockEffectRecord[], CurrentStockEvidenceForAvailabilityUnavailable>;
  readonly readLatestSourceAssertion: (
    positionRef: StockPositionRef,
  ) => Effect.Effect<Option.Option<InventorySourceAssertion>, CurrentStockEvidenceForAvailabilityUnavailable>;
  readonly readPosition: (
    positionRef: StockPositionRef,
  ) => Effect.Effect<Option.Option<StockPosition>, CurrentStockEvidenceForAvailabilityUnavailable>;
  readonly unresolvedCreateEffects: Effect.Effect<
    readonly ReservationCreateEffectForAvailability[],
    CurrentStockEvidenceForAvailabilityUnavailable
  >;
}

const rejected = (reason: CurrentStockEvidenceForAvailabilityRejected['reason'], cause?: unknown) => {
  const failure = new CurrentStockEvidenceForAvailabilityRejected({
    code: 'current_stock_evidence_for_availability_rejected',
    reason,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

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

const sameResourceCandidate = (left: ResourceIdentity, right: ResourceIdentity): boolean =>
  left.resourceId === right.resourceId && left.tenantId === right.tenantId;

const sameMeaning = (left: CatalogToStockBinding, right: StockItem): boolean =>
  left.exactSelectionMeaning.id === right.exactSelectionMeaning.id &&
  left.exactSelectionMeaning.kind === right.exactSelectionMeaning.kind;

const sameAuthority = Schema.toEquivalence(InventoryBackendConfigurationSchema);

const onHandUnitRef = (position: StockPosition) =>
  Match.value(position.onHand).pipe(
    Match.tag('CURRENT', ({ quantity }) => quantity.unitRef),
    Match.tag('STALE', ({ lastKnownQuantity }) => lastKnownQuantity.unitRef),
    Match.tag('UNKNOWN', ({ unitRef }) => unitRef),
    Match.tag('MISSING', ({ unitRef }) => unitRef),
    Match.tag('INDETERMINATE', ({ unitRef }) => unitRef),
    Match.exhaustive,
  );

const committedObligationMatchesPositionScope = (obligation: InventoryObligation, position: StockPosition) => {
  const relevantAllocations = obligation.requirements.flatMap(({ allocations }) =>
    allocations.filter(({ positionRef }) => sameResourceCandidate(positionRef, position.ref)),
  );
  return (
    relevantAllocations.length > 0 &&
    relevantAllocations.every(
      ({ positionRef, quantity, stockItemRef }) =>
        sameResource(positionRef, position.ref) &&
        sameResource(stockItemRef, position.scope.stockItemRef) &&
        sameResource(quantity.unitRef, position.scope.unitRef),
    )
  );
};

const allocationsFor = (effect: ReservationCreateEffectForAvailability) =>
  Match.value(effect).pipe(
    Match.tag('RECONCILIATION_REQUIRED', ({ constrainedAllocations }) => constrainedAllocations),
    Match.tag('INDETERMINATE', ({ possibleConstrainedAllocations }) => possibleConstrainedAllocations),
    Match.tag('REQUESTED', ({ request }) =>
      request.reservation.requirements.flatMap(({ allocations }) =>
        allocations.map(({ positionRef: stockPositionRef, ...allocation }) => ({
          ...allocation,
          stockPositionRef,
        })),
      ),
    ),
    Match.exhaustive,
  );

const constraintFor = (
  effect: ReservationCreateEffectForAvailability,
  position: StockPosition,
  authority: InventoryBackendConfiguration,
): Effect.Effect<Option.Option<UnresolvedReservationEffectConstraint>, CurrentStockEvidenceForAvailabilityRejected> => {
  const allocations = allocationsFor(effect).filter(({ stockPositionRef }) =>
    sameResourceCandidate(stockPositionRef, position.ref),
  );
  if (allocations.length === 0) {
    return Effect.succeedNone;
  }
  if (
    !sameAuthority(effect.request.authority, authority) ||
    allocations.some(
      ({ quantity, stockItemRef, stockPositionRef }) =>
        !sameResource(stockPositionRef, position.ref) ||
        !sameResource(stockItemRef, position.scope.stockItemRef) ||
        !sameResource(quantity.unitRef, position.scope.unitRef),
    )
  ) {
    return Effect.fail(rejected('EVIDENCE_SCOPE_MISMATCH'));
  }
  const common = {
    attemptId: effect.request.reservation.origin.attemptId,
    authority: effect.request.authority,
    countsTowardReserved: false as const,
    effectId: effect.request.effectId,
    meaning: 'UNRESOLVED_RESERVATION_EFFECT_CONSTRAINT' as const,
    mutationId: effect.request.mutationId,
    provesReusableOnHand: false as const,
    requestedAt: effect.request.requestedAt,
    sourceActionInvocationId: effect.request.sourceActionInvocationId,
  };
  return Effect.succeedSome(
    Match.value(effect).pipe(
      Match.tag('RECONCILIATION_REQUIRED', ({ observedAt, ownerEvidenceRef }) => ({
        ...common,
        _tag: 'EXACT' as const,
        constrainedAllocations: allocations,
        observedAt,
        ownerEvidenceRef,
      })),
      Match.tag('INDETERMINATE', ({ observedAt, reason }) => ({
        ...common,
        _tag: 'INDETERMINATE' as const,
        observedAt,
        possibleAllocations: allocations,
        reason,
      })),
      Match.tag('REQUESTED', () => ({
        ...common,
        _tag: 'INDETERMINATE' as const,
        possibleAllocations: allocations,
        reason: 'DISPATCH_PENDING' as const,
      })),
      Match.exhaustive,
    ),
  );
};

const requireSome = <A>(
  option: Option.Option<A>,
  reason: CurrentStockEvidenceForAvailabilityRejected['reason'],
): Effect.Effect<A, CurrentStockEvidenceForAvailabilityRejected> =>
  Effect.fromOption(option).pipe(Effect.mapError((cause) => rejected(reason, cause)));

const sourceEvidenceFor = (
  // oxlint-disable-next-line effect-native/no-dependency-parameters -- This helper composes one already-scoped owner-local read dependency set; expires: 2027-03-31.
  dependencies: CurrentStockEvidenceForAvailabilityDependencies,
  position: StockPosition,
  authority: InventoryBackendConfiguration,
): Effect.Effect<StockSourceEvidenceForAvailability, EvidenceFailure> => {
  if (authority.selection.backend !== 'external_business_system') {
    return Effect.succeed({
      _tag: 'OWNER_MANAGED',
      onHand: position.onHand,
      ownerConfiguration: authority,
      physicalOnHandReusableProof: 'NOT_PROVIDED',
    });
  }
  return Effect.gen(function* externalSourceEvidence() {
    const [maybeAssertion, materialEffects] = yield* Effect.all(
      [dependencies.readLatestSourceAssertion(position.ref), dependencies.listMaterialEffects(position.ref)] as const,
      { concurrency: 2 },
    );
    if (Option.isNone(maybeAssertion)) {
      return {
        _tag: 'MISSING' as const,
        meaning: 'EXTERNAL_SOURCE_ASSERTION' as const,
        onHand: position.onHand,
        ownerConfiguration: authority,
        physicalOnHandReusableProof: 'NOT_PROVIDED' as const,
      };
    }
    if (
      maybeAssertion.value.issuerAuthority !== 'SELECTED_BACKEND' ||
      !sameResource(maybeAssertion.value.positionRef, position.ref) ||
      !sameResource(maybeAssertion.value.stockItemRef, position.scope.stockItemRef) ||
      !sameResource(maybeAssertion.value.stockLocationRef, position.scope.stockLocationRef) ||
      !sameResource(maybeAssertion.value.quantity.unitRef, position.scope.unitRef) ||
      maybeAssertion.value.customerConfigurationId !== position.scope.customerConfigurationId ||
      !sameAuthority(maybeAssertion.value.authorityConfiguration, authority)
    ) {
      return yield* rejected('EVIDENCE_SCOPE_MISMATCH');
    }
    const evaluation = yield* evaluateInventorySourceAssertionCoverage(maybeAssertion.value, materialEffects).pipe(
      Effect.mapError((cause) => rejected('INVALID_EVIDENCE', cause)),
    );
    return {
      _tag: 'EXTERNAL_SOURCE_ASSERTION' as const,
      evaluation,
      materialEffects,
      onHand: position.onHand,
      ownerConfiguration: authority,
      physicalOnHandReusableProof: 'NOT_PROVIDED' as const,
    };
  });
};

// oxlint-disable-next-line effect-native/no-wide-factory-signature -- Core supplies this owner-local transaction-scoped read dependency set after the governed scope gate; expires: 2027-03-31.
export const makeCurrentStockEvidenceForAvailabilityService = (
  // oxlint-disable-next-line effect-native/no-dependency-parameters -- Core supplies this owner-local transaction-scoped read dependency set after the governed scope gate; expires: 2027-03-31.
  dependencies: CurrentStockEvidenceForAvailabilityDependencies,
) => ({
  read: Effect.fn('CurrentStockEvidenceForAvailability.read')(function* readCurrentStockEvidence(
    positionRef: StockPositionRef,
  ): Effect.fn.Return<InventoryStockEvidenceForAvailability, EvidenceFailure> {
    const position = yield* dependencies
      .readPosition(positionRef)
      .pipe(Effect.flatMap((candidate) => requireSome(candidate, 'POSITION_NOT_FOUND')));
    if (!sameResource(position.ref, positionRef)) {
      return yield* rejected('EVIDENCE_SCOPE_MISMATCH');
    }
    if (position.lifecycle !== 'CURRENT') {
      return yield* rejected('POSITION_NOT_CURRENT');
    }

    const [binding, stockItem, stockLocation, authority, allocations, committedObligations, unresolvedEffects] =
      yield* Effect.all(
        [
          dependencies
            .findBinding(position)
            .pipe(Effect.flatMap((candidate) => requireSome(candidate, 'BINDING_NOT_FOUND'))),
          dependencies
            .findStockItem(position)
            .pipe(Effect.flatMap((candidate) => requireSome(candidate, 'STOCK_ITEM_NOT_FOUND'))),
          dependencies
            .findStockLocation(position)
            .pipe(Effect.flatMap((candidate) => requireSome(candidate, 'STOCK_LOCATION_NOT_FOUND'))),
          dependencies
            .findAuthority(position.scope.customerConfigurationId)
            .pipe(Effect.flatMap((candidate) => requireSome(candidate, 'AUTHORITY_NOT_FOUND'))),
          dependencies.listCurrentSuccessfulAllocations(position.ref),
          dependencies.listCommittedObligations(position.ref),
          dependencies.unresolvedCreateEffects,
        ] as const,
        { concurrency: 7 },
      );
    if (stockItem.lifecycle !== 'CURRENT') {
      return yield* rejected('STOCK_ITEM_NOT_CURRENT');
    }
    if (!Schema.is(ActiveLifecycleSchema)(stockLocation.lifecycle)) {
      return yield* rejected('STOCK_LOCATION_NOT_ACTIVE');
    }
    if (
      !sameResource(binding.stockItemRef, position.scope.stockItemRef) ||
      !sameResource(stockItem.stockItemRef, position.scope.stockItemRef) ||
      !sameResource(stockLocation.ref, position.scope.stockLocationRef) ||
      !sameResource(binding.unitRef, position.scope.unitRef) ||
      !sameResource(stockItem.unitRef, position.scope.unitRef) ||
      !sameResource(onHandUnitRef(position), position.scope.unitRef) ||
      !sameMeaning(binding, stockItem) ||
      binding.catalogSelection.productRef.tenantId !== position.ref.tenantId ||
      authority.configurationId !== position.onHand.ownerConfigurationRef.resourceId ||
      authority.customerConfigurationId !== position.scope.customerConfigurationId ||
      authority.tenantId !== position.ref.tenantId ||
      !sameResource(position.onHand.ownerConfigurationRef, {
        moduleId: 'commerce.inventory',
        resourceId: authority.configurationId,
        resourceType: 'commerce.inventory.inventory-backend-configuration',
        tenantId: authority.tenantId,
      }) ||
      allocations.some(
        ({ positionRef: allocationPositionRef, quantity }) =>
          !sameResource(allocationPositionRef, position.ref) || !sameResource(quantity.unitRef, position.scope.unitRef),
      ) ||
      committedObligations.some((obligation) => !committedObligationMatchesPositionScope(obligation, position))
    ) {
      return yield* rejected('EVIDENCE_SCOPE_MISMATCH');
    }

    const unresolvedReservationEffectConstraints = (yield* Effect.forEach(
      unresolvedEffects,
      (effect) => constraintFor(effect, position, authority),
      {
        concurrency: 8,
      },
    )).flatMap((candidate) => Option.match(candidate, { onNone: () => [], onSome: (constraint) => [constraint] }));

    const [provisionalReserved, sourceEvidence]: readonly [
      StockPositionReservedEvidence,
      StockSourceEvidenceForAvailability,
    ] = yield* Effect.all(
      [
        deriveReservedQuantity(position, allocations).pipe(
          Effect.mapError((cause) => rejected('INVALID_EVIDENCE', cause)),
        ),
        sourceEvidenceFor(dependencies, position, authority),
      ] as const,
      { concurrency: 2 },
    );

    return yield* Schema.decodeUnknownEffect(InventoryStockEvidenceForAvailabilitySchema, {
      onExcessProperty: 'error',
    })({
      binding,
      committedObligations,
      customerFacingAvailabilityPublished: false,
      position,
      provisionalReserved,
      purpose: 'STOCK_EVIDENCE_ONLY',
      sourceEvidence,
      stockItem,
      stockLocation,
      unresolvedReservationEffectConstraints,
    }).pipe(Effect.mapError((cause) => rejected('INVALID_EVIDENCE', cause)));
  }),
});
