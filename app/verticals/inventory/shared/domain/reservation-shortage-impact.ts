import { DateTime, Effect, Result, Schema } from 'effect';

import { InventoryStockAllocationSchema } from './inventory-obligation.ts';
import type { InventoryStockAllocation } from './inventory-obligation.ts';
import {
  ReservationConfirmationHealthStateSchema,
  ReservationConfirmationIssuanceRankSchema,
  ReservationConfirmationSchema,
} from './reservation-confirmation.ts';
import {
  ExactStockQuantityAmountSchema,
  StockQuantitySchema,
  addExactStockQuantityAmounts,
  compareExactStockQuantityAmounts,
  subtractExactStockQuantityAmounts,
} from './stock-position.ts';
import type { StockQuantity } from './stock-position.ts';
import { ReservationConfirmationRefSchema } from '../resources/reservation-confirmation.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';
import type { StockPositionRef } from '../resources/stock-position.ts';

export const ReservationShortagePoolBoundarySchema = Schema.Literals([
  'NONE',
  'COMMITMENT_PROTECTED',
  'RELEASED',
  'COMMITTED_OBLIGATION',
]);
export type ReservationShortagePoolBoundary = typeof ReservationShortagePoolBoundarySchema.Type;

export const ReservationShortageCandidateSchema = Schema.Struct({
  allocations: Schema.Array(InventoryStockAllocationSchema).check(Schema.isMinLength(1)),
  confirmation: ReservationConfirmationSchema,
  poolBoundary: ReservationShortagePoolBoundarySchema,
});
export type ReservationShortageCandidate = typeof ReservationShortageCandidateSchema.Type;

export const ReservationShortageImpactInputSchema = Schema.Struct({
  affectedPositionRef: StockPositionRefSchema,
  availableQuantity: StockQuantitySchema,
  candidates: Schema.Array(ReservationShortageCandidateSchema),
});
export type ReservationShortageImpactInput = typeof ReservationShortageImpactInputSchema.Type;

const ReservationShortageDecisionSchema = Schema.Struct({
  affectedQuantity: StockQuantitySchema,
  capacity: Schema.Literals(['HONORABLE', 'SHORTAGE']),
  confirmationRef: ReservationConfirmationRefSchema,
  currentHealth: ReservationConfirmationHealthStateSchema,
  issuanceRank: ReservationConfirmationIssuanceRankSchema,
});
type ReservationShortageDecision = typeof ReservationShortageDecisionSchema.Type;

const DeterminateReservationShortageImpactSchema = Schema.TaggedStruct('DETERMINATE', {
  affectedPositionRef: StockPositionRefSchema,
  decisions: Schema.Array(ReservationShortageDecisionSchema),
  fencedAmount: ExactStockQuantityAmountSchema,
});

const IndeterminateReservationShortageImpactSchema = Schema.TaggedStruct('INDETERMINATE', {
  affectedPositionRef: StockPositionRefSchema,
  candidateRefs: Schema.Array(ReservationConfirmationRefSchema).check(Schema.isMinLength(2)),
  fencedAmount: ExactStockQuantityAmountSchema,
  reason: Schema.Literal('AUTHORITATIVE_ISSUANCE_ORDER_UNRESOLVABLE'),
  reconciliationRequired: Schema.Literal(true),
});

export const ReservationShortageImpactEvaluationSchema = Schema.Union([
  DeterminateReservationShortageImpactSchema,
  IndeterminateReservationShortageImpactSchema,
]);
export type ReservationShortageImpactEvaluation = typeof ReservationShortageImpactEvaluationSchema.Type;

export class ReservationShortageImpactRejected extends Schema.TaggedError<ReservationShortageImpactRejected>()(
  'ReservationShortageImpactRejected',
  {
    affectedPositionRef: StockPositionRefSchema,
    code: Schema.Literal('inventory_reservation_shortage_impact_rejected'),
    confirmationRef: Schema.optionalKey(ReservationConfirmationRefSchema),
    reason: Schema.Literals([
      'TENANT_SCOPE_MISMATCH',
      'AVAILABLE_QUANTITY_UNIT_MISMATCH',
      'DUPLICATE_CONFIRMATION',
      'CANDIDATE_ALLOCATION_MISMATCH',
      'CANDIDATE_ALLOCATION_UNIT_MISMATCH',
      'INVALID_AFFECTED_QUANTITY',
    ]),
  },
) {}

interface EligibleCandidate {
  readonly affectedQuantity: StockQuantity;
  readonly candidate: ReservationShortageCandidate;
}

interface CollectedCandidates {
  readonly eligible: readonly EligibleCandidate[];
  readonly fencedAmount: StockQuantity['amount'];
}

const sameRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sameAllocation = (left: InventoryStockAllocation, right: InventoryStockAllocation) =>
  String(left.allocationId) === String(right.allocationId) &&
  left.quantity.amount === right.quantity.amount &&
  sameRef(left.positionRef, right.positionRef) &&
  sameRef(left.quantity.unitRef, right.quantity.unitRef) &&
  sameRef(left.stockItemRef, right.stockItemRef);

const rejection = (
  affectedPositionRef: StockPositionRef,
  reason: ReservationShortageImpactRejected['reason'],
  confirmationRef?: typeof ReservationConfirmationRefSchema.Type,
) =>
  confirmationRef === undefined
    ? new ReservationShortageImpactRejected({
        affectedPositionRef,
        code: 'inventory_reservation_shortage_impact_rejected',
        reason,
      })
    : new ReservationShortageImpactRejected({
        affectedPositionRef,
        code: 'inventory_reservation_shortage_impact_rejected',
        confirmationRef,
        reason,
      });

const isInPriorityPool = ({ confirmation, poolBoundary }: ReservationShortageCandidate) =>
  poolBoundary === 'NONE' &&
  (confirmation.health.state === 'VALID' ||
    confirmation.health.state === 'AT_RISK' ||
    confirmation.health.state === 'UNVERIFIABLE');

const fencesCapacity = ({ confirmation, poolBoundary }: ReservationShortageCandidate) =>
  poolBoundary === 'COMMITMENT_PROTECTED' ||
  poolBoundary === 'COMMITTED_OBLIGATION' ||
  (poolBoundary === 'NONE' && (confirmation.health.state === 'EXPIRED' || confirmation.health.state === 'REVOKED'));

const candidateRefKey = ({ confirmation: { ref } }: ReservationShortageCandidate) =>
  `${ref.tenantId}:${ref.resourceId}`;

const issuanceEpoch = (candidate: ReservationShortageCandidate) =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(candidate.confirmation.issuanceRank.issuedAt));

const compareAuthoritativeRank = (left: EligibleCandidate, right: EligibleCandidate) => {
  const issuedAtOrder = issuanceEpoch(left.candidate) - issuanceEpoch(right.candidate);
  return issuedAtOrder === 0
    ? String(left.candidate.confirmation.ref.resourceId).localeCompare(
        String(right.candidate.confirmation.ref.resourceId),
      )
    : issuedAtOrder;
};

const invalidAffectedQuantity = (
  affectedPositionRef: StockPositionRef,
  confirmationRef: typeof ReservationConfirmationRefSchema.Type | undefined,
  cause: unknown,
) => {
  const failure = rejection(affectedPositionRef, 'INVALID_AFFECTED_QUANTITY', confirmationRef);
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const collectEligibleCandidates = (
  input: ReservationShortageImpactInput,
): Result.Result<CollectedCandidates, ReservationShortageImpactRejected> => {
  const { affectedPositionRef, availableQuantity, candidates } = input;
  if (
    availableQuantity.unitRef.tenantId !== affectedPositionRef.tenantId ||
    candidates.some(({ confirmation }) => confirmation.ref.tenantId !== affectedPositionRef.tenantId)
  ) {
    return Result.fail(rejection(affectedPositionRef, 'TENANT_SCOPE_MISMATCH'));
  }
  const seenConfirmationRefs = new Set<string>();
  const eligible: EligibleCandidate[] = [];
  let fencedAmount = ExactStockQuantityAmountSchema.make('0');
  for (const candidate of candidates) {
    const confirmationRef = candidate.confirmation.ref;
    const confirmationRefKey = candidateRefKey(candidate);
    if (seenConfirmationRefs.has(confirmationRefKey)) {
      return Result.fail(rejection(affectedPositionRef, 'DUPLICATE_CONFIRMATION', confirmationRef));
    }
    seenConfirmationRefs.add(confirmationRefKey);

    const persistedAllocations = candidate.confirmation.reservation.requirements.flatMap(
      ({ allocations }) => allocations,
    );
    if (
      persistedAllocations.length !== candidate.allocations.length ||
      persistedAllocations.some(
        (persisted) =>
          !candidate.allocations.some((candidateAllocation) => sameAllocation(persisted, candidateAllocation)),
      )
    ) {
      return Result.fail(rejection(affectedPositionRef, 'CANDIDATE_ALLOCATION_MISMATCH', confirmationRef));
    }

    const participatesInCapacity = isInPriorityPool(candidate) || fencesCapacity(candidate);
    const affectedAllocations = participatesInCapacity
      ? candidate.allocations.filter(({ positionRef }) => sameRef(positionRef, affectedPositionRef))
      : [];
    if (affectedAllocations.length > 0) {
      if (affectedAllocations.some(({ quantity }) => !sameRef(quantity.unitRef, availableQuantity.unitRef))) {
        return Result.fail(rejection(affectedPositionRef, 'CANDIDATE_ALLOCATION_UNIT_MISMATCH', confirmationRef));
      }

      const [firstAffectedAllocation, ...remainingAffectedAllocations] = affectedAllocations;
      if (firstAffectedAllocation !== undefined) {
        let affectedAmount = firstAffectedAllocation.quantity.amount;
        for (const { quantity } of remainingAffectedAllocations) {
          const sum = addExactStockQuantityAmounts(affectedAmount, quantity.amount);
          if (Result.isFailure(sum)) {
            return Result.fail(invalidAffectedQuantity(affectedPositionRef, confirmationRef, sum.failure));
          }
          affectedAmount = sum.success;
        }
        if (affectedAmount !== '0' && isInPriorityPool(candidate)) {
          eligible.push({
            affectedQuantity: { amount: affectedAmount, unitRef: availableQuantity.unitRef },
            candidate,
          });
        } else if (affectedAmount !== '0' && fencesCapacity(candidate)) {
          const sum = addExactStockQuantityAmounts(fencedAmount, affectedAmount);
          if (Result.isFailure(sum)) {
            return Result.fail(invalidAffectedQuantity(affectedPositionRef, confirmationRef, sum.failure));
          }
          fencedAmount = sum.success;
        }
      }
    }
  }
  return Result.succeed({ eligible, fencedAmount });
};

const evaluateImpact = (
  input: ReservationShortageImpactInput,
): Result.Result<ReservationShortageImpactEvaluation, ReservationShortageImpactRejected> => {
  const { affectedPositionRef, availableQuantity } = input;

  const collected = collectEligibleCandidates(input);
  if (Result.isFailure(collected)) {
    return Result.fail(collected.failure);
  }
  const { eligible: collectedEligible, fencedAmount } = collected.success;
  const eligible = [...collectedEligible];
  eligible.sort(compareAuthoritativeRank);
  for (let index = 1; index < eligible.length; index += 1) {
    const previous = eligible[index - 1];
    const current = eligible[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      issuanceEpoch(previous.candidate) === issuanceEpoch(current.candidate)
    ) {
      return Result.succeed({
        _tag: 'INDETERMINATE',
        affectedPositionRef,
        candidateRefs: eligible.map(({ candidate }) => candidate.confirmation.ref),
        fencedAmount,
        reason: 'AUTHORITATIVE_ISSUANCE_ORDER_UNRESOLVABLE',
        reconciliationRequired: true,
      });
    }
  }

  let remaining = availableQuantity.amount;
  if (fencedAmount !== '0') {
    const unfenced = subtractExactStockQuantityAmounts(
      remaining,
      compareExactStockQuantityAmounts(remaining, fencedAmount) >= 0 ? fencedAmount : remaining,
    );
    if (Result.isFailure(unfenced)) {
      return Result.fail(invalidAffectedQuantity(affectedPositionRef, undefined, unfenced.failure));
    }
    remaining = unfenced.success;
  }
  let shortageStarted = false;
  const decisions: ReservationShortageDecision[] = [];
  for (const { affectedQuantity, candidate } of eligible) {
    const honorable = !shortageStarted && compareExactStockQuantityAmounts(remaining, affectedQuantity.amount) >= 0;
    if (honorable) {
      const nextRemaining = subtractExactStockQuantityAmounts(remaining, affectedQuantity.amount);
      if (Result.isFailure(nextRemaining)) {
        return Result.fail(
          invalidAffectedQuantity(affectedPositionRef, candidate.confirmation.ref, nextRemaining.failure),
        );
      }
      remaining = nextRemaining.success;
    } else {
      shortageStarted = true;
    }
    decisions.push({
      affectedQuantity,
      capacity: honorable ? 'HONORABLE' : 'SHORTAGE',
      confirmationRef: candidate.confirmation.ref,
      currentHealth: candidate.confirmation.health.state,
      issuanceRank: candidate.confirmation.issuanceRank,
    });
  }

  return Result.succeed({ _tag: 'DETERMINATE', affectedPositionRef, decisions, fencedAmount });
};

export const deriveReservationShortageFencedAmount = Effect.fn('deriveReservationShortageFencedAmount')(
  (input: ReservationShortageImpactInput) =>
    Effect.fromResult(collectEligibleCandidates(input)).pipe(Effect.map(({ fencedAmount }) => fencedAmount)),
);

/**
 * Evaluates only the affected constrained Position. Exiting this priority pool never implies that
 * a backend Reservation has been released or that its Quantity is reusable.
 */
export const evaluateReservationShortageImpact = Effect.fn('evaluateReservationShortageImpact')(
  (input: ReservationShortageImpactInput) => Effect.fromResult(evaluateImpact(input)),
);
