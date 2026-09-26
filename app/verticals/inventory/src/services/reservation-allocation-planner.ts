/* oxlint-disable sonarjs/no-nested-functions -- The planner's named Effect folds close over one transaction-local constrained-stock pool; extracting them would hide that ownership; expires: 2027-03-31. */
import type { Effect as EffectType } from 'effect';
import { Effect, Schema } from 'effect';

import type { InventoryBackendConfiguration } from '../../shared/domain/inventory-backend-configuration.ts';
import type {
  InventoryObligationRequirement,
  InventoryStockAllocation,
  StockAllocationIdSchema,
} from '../../shared/domain/inventory-obligation.ts';
import {
  InventoryReservationCreateRejected,
  InventoryReservationCreateUnavailable,
} from '../../shared/domain/inventory-reservation-create.ts';
import type { ResolvedCatalogStockDemand } from '../../shared/domain/catalog-to-stock-binding.ts';
import type { TrustedCurrentCommercePurchasingContext } from '../../shared/domain/stock-sharing-eligibility.ts';
import type { StockPosition } from '../../shared/domain/stock-position.ts';
import { CurrentOnHandEvidenceSchema, ExactStockQuantityAmountSchema } from '../../shared/domain/stock-position.ts';
import type { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';

interface ReservationAllocationCandidate {
  readonly position: StockPosition;
  readonly reservedAmount: string;
}

export interface ReservationAllocationCandidateReader {
  /** Locks every returned Current Position so competing Action transactions cannot over-allocate it. */
  readonly lockCurrentForItem: (
    effectId: typeof ReservationAuthorityEffectIdSchema.Type,
    authority: InventoryBackendConfiguration,
    demand: ResolvedCatalogStockDemand,
  ) => EffectType.Effect<readonly ReservationAllocationCandidate[], InventoryReservationCreateUnavailable>;
}

export interface ReservationPositionEligibility {
  readonly isEligible: (
    effectId: typeof ReservationAuthorityEffectIdSchema.Type,
    authority: InventoryBackendConfiguration,
    position: StockPosition,
    context: TrustedCurrentCommercePurchasingContext,
  ) => EffectType.Effect<boolean, InventoryReservationCreateUnavailable>;
}

interface Decimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

const decimal = (value: string): Decimal => {
  const [integer = '0', fraction = ''] = value.split('.');
  return { coefficient: BigInt(`${integer}${fraction}`), scale: fraction.length };
};

const aligned = (left: Decimal, right: Decimal) => {
  const scale = Math.max(left.scale, right.scale);
  return {
    left: left.coefficient * 10n ** BigInt(scale - left.scale),
    right: right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  };
};

const subtract = (left: Decimal, right: Decimal): Decimal => {
  const values = aligned(left, right);
  return { coefficient: values.left - values.right, scale: values.scale };
};

const minimum = (left: Decimal, right: Decimal): Decimal => {
  const values = aligned(left, right);
  return values.left <= values.right
    ? { coefficient: values.left, scale: values.scale }
    : { coefficient: values.right, scale: values.scale };
};

const positive = ({ coefficient }: Decimal) => coefficient > 0n;

const amount = ({ coefficient, scale }: Decimal): string => {
  const sign = coefficient < 0n ? '-' : '';
  const digits = (coefficient < 0n ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  if (scale === 0) {
    return `${sign}${digits}`;
  }
  const integer = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/u, '');
  return fraction.length === 0 ? `${sign}${integer}` : `${sign}${integer}.${fraction}`;
};

const sameRef = (
  left: { readonly resourceId: string; readonly tenantId: string },
  right: { readonly resourceId: string; readonly tenantId: string },
) => left.resourceId === right.resourceId && left.tenantId === right.tenantId;

const sameUnit = (left: StockPosition['scope']['unitRef'], right: StockPosition['scope']['unitRef']) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const isCandidateInExactAuthorityScope = (
  position: StockPosition,
  authority: InventoryBackendConfiguration,
  demand: ResolvedCatalogStockDemand,
) =>
  position.lifecycle === 'CURRENT' &&
  Schema.is(CurrentOnHandEvidenceSchema)(position.onHand) &&
  position.scope.customerConfigurationId === authority.customerConfigurationId &&
  sameRef(position.scope.stockItemRef, demand.stockItem.stockItemRef) &&
  sameUnit(position.scope.unitRef, demand.unitRef) &&
  sameRef(position.onHand.ownerConfigurationRef, {
    resourceId: authority.configurationId,
    tenantId: authority.tenantId,
  });

interface PlannedAmount {
  readonly allocated: Decimal;
  readonly position: StockPosition;
}

const takeExactAmounts = (
  ordered: readonly StockPosition[],
  requested: Decimal,
  remainingByPosition: Map<string, Decimal>,
) => {
  let needed = requested;
  const planned: PlannedAmount[] = [];
  for (const position of ordered) {
    const positionId = position.ref.resourceId;
    const available = remainingByPosition.get(positionId) ?? { coefficient: 0n, scale: 0 };
    if (positive(needed) && positive(available)) {
      const allocated = minimum(needed, available);
      planned.push({ allocated, position });
      remainingByPosition.set(positionId, subtract(available, allocated));
      needed = subtract(needed, allocated);
    }
  }
  return { needed, planned };
};

export const makeReservationAllocationPlanner = (dependencies: {
  readonly candidates: ReservationAllocationCandidateReader;
  readonly eligibility: ReservationPositionEligibility;
  readonly makeAllocationId: (input: {
    readonly effectId: string;
    readonly positionId: string;
    readonly purchaseDemandOccurrenceId: string;
  }) => typeof StockAllocationIdSchema.Type;
}) => ({
  plan: Effect.fn('ReservationAllocationPlanner.plan')(function* planExactRequirements(
    effectId: typeof ReservationAuthorityEffectIdSchema.Type,
    authority: InventoryBackendConfiguration,
    demands: readonly ResolvedCatalogStockDemand[],
    context: TrustedCurrentCommercePurchasingContext,
    afterContentionLocked: () => EffectType.Effect<
      boolean,
      InventoryReservationCreateRejected | InventoryReservationCreateUnavailable
    > = () => Effect.succeed(false),
  ) {
    const remainingByPosition = new Map<string, Decimal>();
    const positionById = new Map<string, StockPosition>();
    // Canonical lock acquisition prevents equivalent multi-Position Attempts from
    // deadlocking without turning technical arrival order into customer priority.
    const contentionDemands = demands
      .toSorted((left, right) => {
        const stockItemOrder = left.stockItem.stockItemRef.resourceId.localeCompare(
          right.stockItem.stockItemRef.resourceId,
        );
        return stockItemOrder === 0
          ? left.purchaseDemandOccurrenceId.localeCompare(right.purchaseDemandOccurrenceId)
          : stockItemOrder;
      })
      .filter(
        (demand, index, ordered) =>
          index === 0 ||
          ordered[index - 1]?.stockItem.stockItemRef.resourceId !== demand.stockItem.stockItemRef.resourceId,
      );
    yield* Effect.forEach(
      contentionDemands,
      Effect.fn('ReservationAllocationPlanner.lockContentionScope')(function* lockContentionScope(demand) {
        const candidates = yield* dependencies.candidates.lockCurrentForItem(effectId, authority, demand);
        const eligible = yield* Effect.forEach(
          candidates.filter(({ position }) => isCandidateInExactAuthorityScope(position, authority, demand)),
          (candidate) =>
            dependencies.eligibility
              .isEligible(effectId, authority, candidate.position, context)
              .pipe(Effect.map((isEligible) => (isEligible ? [candidate] : []))),
          { concurrency: 1 },
        );
        const eligibleCandidates = eligible.flat();
        for (const { position, reservedAmount } of eligibleCandidates) {
          if (!Schema.is(CurrentOnHandEvidenceSchema)(position.onHand)) {
            continue;
          }
          const positionId = position.ref.resourceId;
          const available = subtract(decimal(position.onHand.quantity.amount), decimal(reservedAmount));
          remainingByPosition.set(positionId, positive(available) ? available : { coefficient: 0n, scale: 0 });
          positionById.set(positionId, position);
        }
      }),
      { concurrency: 1 },
    );
    if (yield* afterContentionLocked()) {
      return [];
    }
    return yield* Effect.reduce(
      demands,
      (): InventoryObligationRequirement[] => [],
      Effect.fn('ReservationAllocationPlanner.planDemandOccurrence')(
        function* planDemandOccurrence(requirements, demand) {
          const ordered = [...positionById.values()]
            .filter((position) => sameRef(position.scope.stockItemRef, demand.stockItem.stockItemRef))
            .toSorted((left, right) => left.ref.resourceId.localeCompare(right.ref.resourceId));
          const { needed, planned } = takeExactAmounts(ordered, decimal(demand.quantity), remainingByPosition);
          if (positive(needed)) {
            return yield* new InventoryReservationCreateRejected({
              code: 'inventory_reservation_create_rejected',
              effectId,
              reason: 'INSUFFICIENT_CONSTRAINED_STOCK',
            });
          }
          const allocations: InventoryStockAllocation[] = yield* Effect.forEach(
            planned,
            ({ allocated, position }) =>
              Schema.decodeEffect(ExactStockQuantityAmountSchema)(amount(allocated)).pipe(
                Effect.mapError((cause) => {
                  const failure = new InventoryReservationCreateUnavailable({
                    code: 'inventory_reservation_create_unavailable',
                    effectId,
                    reason: 'Planned exact allocation Quantity is invalid',
                    retryable: true,
                  });
                  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
                  return failure;
                }),
                Effect.map((allocatedAmount) => ({
                  allocationId: dependencies.makeAllocationId({
                    effectId,
                    positionId: position.ref.resourceId,
                    purchaseDemandOccurrenceId: demand.purchaseDemandOccurrenceId,
                  }),
                  positionRef: position.ref,
                  quantity: { amount: allocatedAmount, unitRef: demand.unitRef },
                  stockItemRef: demand.stockItem.stockItemRef,
                })),
              ),
            { concurrency: 1 },
          );
          return [...requirements, { ...demand, allocations }];
        },
      ),
    );
  }),
});
