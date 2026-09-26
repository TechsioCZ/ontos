import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { Effect, Match, Option } from 'effect';

import { InventoryReservationCreateUnavailable } from '../../shared/domain/inventory-reservation-create.ts';
import type {
  ReservationCreateAllocation,
  ReservationCreateEffect,
} from '../../shared/domain/inventory-reservation-create.ts';
import { commerceScopeMatchesRelation } from '../../shared/domain/stock-sharing-eligibility.ts';
import type { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import type {
  ReservationAllocationCandidateReader,
  ReservationPositionEligibility,
} from '../services/reservation-allocation-planner.ts';
import { inventoryObligationAllocations, inventoryObligations } from './inventory-obligation-table.ts';
import { listUnresolvedReservationCreateEffects } from './reservation-create-effect-repository.ts';
import { inventoryReservationReleaseEffects } from './reservation-release-effect-table.ts';
import { inventoryStockPositions } from './stock-position-table.ts';
import { stockPositionPersistenceForScope } from './stock-position-repository.ts';
import { stockSharingEligibilityPersistenceForScope } from './stock-sharing-eligibility-repository.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const unavailable = (effectId: typeof ReservationAuthorityEffectIdSchema.Type, reason: string, cause?: unknown) => {
  const failure = new InventoryReservationCreateUnavailable({
    code: 'inventory_reservation_create_unavailable',
    effectId,
    reason,
    retryable: true,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

interface Decimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

const decimal = (value: string): Decimal => {
  const [integer = '0', fraction = ''] = value.split('.');
  return { coefficient: BigInt(`${integer}${fraction}`), scale: fraction.length };
};

const add = (left: Decimal, right: Decimal): Decimal => {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) + right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  };
};

const amount = ({ coefficient, scale }: Decimal): string => {
  const digits = coefficient.toString().padStart(scale + 1, '0');
  if (scale === 0) {
    return digits;
  }
  const integer = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/u, '');
  return fraction.length === 0 ? integer : `${integer}.${fraction}`;
};

const activeAllocations = (record: ReservationCreateEffect): readonly ReservationCreateAllocation[] =>
  Match.value(record).pipe(
    Match.tag('RECONCILIATION_REQUIRED', ({ constrainedAllocations }) => constrainedAllocations),
    Match.tag('INDETERMINATE', ({ possibleConstrainedAllocations }) => possibleConstrainedAllocations),
    Match.tag('REQUESTED', ({ request }) =>
      request.reservation.requirements.flatMap(({ allocations }) =>
        allocations.map(({ positionRef, ...allocation }) => ({ ...allocation, stockPositionRef: positionRef })),
      ),
    ),
    Match.tag('ESTABLISHED', () => []),
    Match.tag('RESOLVED_NO_RESERVATION', () => []),
    Match.exhaustive,
  );

const sumAmounts = (values: Iterable<string>) => {
  let total: Decimal = { coefficient: 0n, scale: 0 };
  for (const value of values) {
    total = add(total, decimal(value));
  }
  return total;
};

const unresolvedAmountsForPosition = (
  unresolved: readonly ReservationCreateEffect[],
  stockPositionId: string,
): string[] => {
  const values: string[] = [];
  for (const effect of unresolved) {
    for (const allocation of activeAllocations(effect)) {
      if (allocation.stockPositionRef.resourceId === stockPositionId) {
        values.push(allocation.quantity.amount);
      }
    }
  }
  return values;
};

const buildCandidate = Effect.fn('ReservationAllocationCandidateReader.buildCandidate')(function* buildCandidate({
  effectId,
  positions,
  scope,
  stockPositionId,
  transaction,
  unresolved,
}: {
  readonly effectId: typeof ReservationAuthorityEffectIdSchema.Type;
  readonly positions: ReturnType<typeof stockPositionPersistenceForScope>;
  readonly scope: OperationalScope;
  readonly stockPositionId: string;
  readonly transaction: ScopedTransaction;
  readonly unresolved: readonly ReservationCreateEffect[];
}) {
  const ref = {
    moduleId: 'commerce.inventory' as const,
    resourceId: stockPositionId,
    resourceType: 'commerce.inventory.stock-position' as const,
    tenantId: scope.tenantId,
  };
  const [current, obligationRows] = yield* Effect.all(
    [
      positions.read(ref).pipe(
        Effect.mapError((cause) => unavailable(effectId, 'Stock Position candidate is unavailable', cause)),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(unavailable(effectId, 'Locked Stock Position candidate disappeared')),
            onSome: Effect.succeed,
          }),
        ),
      ),
      transaction
        .select({ amount: inventoryObligationAllocations.allocatedAmount })
        .from(inventoryObligationAllocations)
        .innerJoin(
          inventoryObligations,
          and(
            eq(inventoryObligations.tenantId, inventoryObligationAllocations.tenantId),
            eq(inventoryObligations.obligationId, inventoryObligationAllocations.obligationId),
          ),
        )
        .leftJoin(
          inventoryReservationReleaseEffects,
          and(
            eq(inventoryReservationReleaseEffects.tenantId, inventoryObligationAllocations.tenantId),
            eq(inventoryReservationReleaseEffects.reservationId, inventoryObligationAllocations.obligationId),
          ),
        )
        .where(
          and(
            eq(inventoryObligationAllocations.tenantId, scope.tenantId),
            eq(inventoryObligationAllocations.stockPositionId, stockPositionId),
            eq(inventoryObligations.lifecycleMeaning, 'PROVISIONAL_RESERVATION'),
            or(
              isNull(inventoryReservationReleaseEffects.releaseEffectRecordId),
              ne(inventoryReservationReleaseEffects.currentState, 'RELEASED'),
            ),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            unavailable(effectId, 'Current successful Reservation Allocations are unavailable', cause),
          ),
        ),
    ],
    { concurrency: 2 },
  );
  const obligationReserved = sumAmounts(obligationRows.map(({ amount: value }) => value));
  const unresolvedReserved = sumAmounts(unresolvedAmountsForPosition(unresolved, stockPositionId));
  return {
    position: current,
    reservedAmount: amount(add(obligationReserved, unresolvedReserved)),
  };
});

export const reservationAllocationCandidateReaderForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): ReservationAllocationCandidateReader => {
  const positions = stockPositionPersistenceForScope(transaction, scope);

  return {
    lockCurrentForItem: Effect.fn('ReservationAllocationCandidateReader.lockCurrentForItem')(
      function* lockCurrentForItem(effectId, authority, demand) {
        if (authority.tenantId !== scope.tenantId || demand.stockItem.stockItemRef.tenantId !== scope.tenantId) {
          return yield* unavailable(effectId, 'Reservation candidate scope does not match trusted Tenant');
        }
        const rows = yield* transaction
          .select({ stockPositionId: inventoryStockPositions.stockPositionId })
          .from(inventoryStockPositions)
          .where(
            and(
              eq(inventoryStockPositions.tenantId, scope.tenantId),
              eq(inventoryStockPositions.customerConfigurationId, authority.customerConfigurationId),
              eq(inventoryStockPositions.ownerConfigurationId, authority.configurationId),
              eq(inventoryStockPositions.stockItemId, demand.stockItem.stockItemRef.resourceId),
              eq(inventoryStockPositions.lifecycleState, 'CURRENT'),
            ),
          )
          .orderBy(inventoryStockPositions.stockPositionId)
          .for('update')
          .pipe(Effect.mapError((cause) => unavailable(effectId, 'Stock Position candidates are unavailable', cause)));
        // oxlint-disable-next-line effect-native/no-sequential-independent-yields -- Candidate rows must be locked before unresolved-effect availability is snapshotted; expires: 2027-03-31.
        const unresolved = yield* listUnresolvedReservationCreateEffects(transaction, scope).pipe(
          Effect.mapError((cause) =>
            unavailable(effectId, 'Unresolved Reservation constraints are unavailable', cause),
          ),
        );
        return yield* Effect.forEach(
          rows,
          ({ stockPositionId }) =>
            buildCandidate({ effectId, positions, scope, stockPositionId, transaction, unresolved }),
          { concurrency: 1 },
        );
      },
    ),
  };
};

export const reservationPositionEligibilityForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): ReservationPositionEligibility => {
  const persistence = stockSharingEligibilityPersistenceForScope(transaction, scope);
  return {
    isEligible: (effectId, authority, position, context) =>
      persistence
        .listCurrent({
          customerConfigurationId: authority.customerConfigurationId,
          ownerConfigurationRef: {
            moduleId: 'commerce.inventory',
            resourceId: authority.configurationId,
            resourceType: 'commerce.inventory.inventory-backend-configuration',
            tenantId: authority.tenantId,
          },
          positionRef: position.ref,
        })
        .pipe(
          Effect.mapError((cause) => unavailable(effectId, 'Stock Sharing Eligibility evidence is unavailable', cause)),
          Effect.map((relations) =>
            relations.some(
              (relation) => relation.lifecycle === 'CURRENT' && commerceScopeMatchesRelation(relation.subject, context),
            ),
          ),
        ),
  };
};
