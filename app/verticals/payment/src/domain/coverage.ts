import { Array as EffectArray, Data, Effect, Option, Result } from 'effect';

import { paymentConflict } from '../../shared/domain/payment-conflict.ts';
import type { PaymentConflict } from '../../shared/domain/payment-conflict.ts';
import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import type { PaymentRefundableItemsBasis } from '../../shared/domain/payment-refund-basis.ts';
import { paymentRejected } from '../../shared/domain/payment-rejected.ts';
import type { PaymentRejected } from '../../shared/domain/payment-rejected.ts';
import type {
  PaymentFundsHoldReason,
  PaymentOperationKind,
  PaymentOperationOutcome,
  PaymentRefundableItemAvailability,
  PaymentRefundBasisKind,
} from '../../shared/domain/payment-vocabulary.ts';
import { addAmounts, isZeroAmount, subtractAmounts, sumAmounts } from './money.ts';
import { isUnresolvedOutcome } from './operation-lifecycle.ts';

/**
 * The one Payment funds calculator shared by authorization (#1149), refunds (#1150) and evidence
 * (#1151). Confirmed returns and safe reservations are each counted once against the authoritatively
 * established collection; they are never compared with a balance that already subtracted them.
 */

/** One persisted operation as the funds guard needs it. */
export interface PaymentFundsOperation {
  readonly amount: PaymentMonetaryAmount;
  readonly kind: PaymentOperationKind;
  readonly operationId: string;
  readonly outcome: PaymentOperationOutcome;
  readonly targetOperationId: string | undefined;
}

/** Everything the guard reads; loaded under the Payment row lock by `loadAggregate`. */
export interface PaymentFundsSnapshot {
  /** Accepted qualified source corrections that disprove funds of the established collection. */
  readonly collectionCorrections: readonly PaymentMonetaryAmount[];
  readonly operations: readonly PaymentFundsOperation[];
  /** The exact authoritative Purchase Payable Amount of the Payment. */
  readonly required: PaymentMonetaryAmount;
  /** Open reconciliation debt (held, ambiguous or conflicting evidence) affecting this Payment. */
  readonly unresolvedEvidence: boolean;
}

export type PaymentFundsLedgerCase = Data.TaggedEnum<{
  /** Proven collection with every confirmed return and live reservation counted once. */
  Established: {
    /** Authoritatively established collection after source corrections. */
    readonly collected: PaymentMonetaryAmount;
    readonly collectOperationId: string;
    readonly confirmedReturned: PaymentMonetaryAmount;
    /** collected - confirmedReturned - reserved. */
    readonly remaining: PaymentMonetaryAmount;
    /** PENDING, INDETERMINATE and CONFLICT returns; a conflict never releases its reservation. */
    readonly reserved: PaymentMonetaryAmount;
  };
  /** Evidence is ambiguous or inconsistent: hold for reconciliation, never invent funds. */
  Held: { readonly reason: PaymentFundsHoldReason };
  /** No COLLECT has reached EFFECT_CONFIRMED (none, live or definitively not effected). */
  NotCollected: { readonly liveCollectOperationId: Option.Option<string> };
}>;
export const PaymentFundsLedger = Data.taggedEnum<PaymentFundsLedgerCase>();
type EstablishedFunds = Data.TaggedEnum.Value<PaymentFundsLedgerCase, 'Established'>;

const held = (reason: PaymentFundsHoldReason) => PaymentFundsLedger.Held({ reason });

interface ReturnTotals {
  readonly confirmed: PaymentMonetaryAmount[];
  readonly reserved: PaymentMonetaryAmount[];
}

const classifyReturns = (snapshot: PaymentFundsSnapshot, collect: PaymentFundsOperation) => {
  const totals: ReturnTotals = { confirmed: [], reserved: [] };
  let cancellationAgainstCollection = false;
  let foreignTarget = false;
  for (const operation of snapshot.operations) {
    if (operation.kind === 'REFUND') {
      // A refund proven not effected neither returned nor reserves funds, whichever collection it named.
      foreignTarget ||=
        operation.outcome !== 'NOT_EFFECTED_CONFIRMED' && operation.targetOperationId !== collect.operationId;
      if (operation.outcome === 'EFFECT_CONFIRMED') {
        totals.confirmed.push(operation.amount);
      } else if (isUnresolvedOutcome(operation.outcome)) {
        totals.reserved.push(operation.amount);
      }
    } else if (operation.kind === 'CANCEL_OR_VOID') {
      // A live or confirmed cancellation of an already proven collection is contradictory evidence.
      cancellationAgainstCollection ||=
        operation.targetOperationId === collect.operationId && operation.outcome !== 'NOT_EFFECTED_CONFIRMED';
    }
  }
  return { cancellationAgainstCollection, foreignTarget, totals };
};

const establishedLedger = (snapshot: PaymentFundsSnapshot, collect: PaymentFundsOperation): PaymentFundsLedgerCase => {
  const { cancellationAgainstCollection, foreignTarget, totals } = classifyReturns(snapshot, collect);
  if (foreignTarget) {
    return held('INCONSISTENT_EVIDENCE');
  }
  if (cancellationAgainstCollection) {
    return held('CANCELLATION_AGAINST_COLLECTION');
  }
  const { currency } = snapshot.required;
  const ledger = Result.gen(function* computeEstablishedFunds() {
    const corrections = yield* sumAmounts(snapshot.collectionCorrections, currency);
    const collected = yield* subtractAmounts(collect.amount, corrections);
    const confirmedReturned = yield* sumAmounts(totals.confirmed, currency);
    const reserved = yield* sumAmounts(totals.reserved, currency);
    const remaining = yield* subtractAmounts(collected, yield* addAmounts(confirmedReturned, reserved));
    return PaymentFundsLedger.Established({
      collected,
      collectOperationId: collect.operationId,
      confirmedReturned,
      remaining,
      reserved,
    });
  });
  // Currency drift, or returns/corrections beyond the established collection, cannot be explained.
  return Result.getOrElse(ledger, () => held('INCONSISTENT_EVIDENCE'));
};

/** Derives the Current funds ledger of one Payment from its persisted operations and evidence. */
export const computePaymentFunds = (snapshot: PaymentFundsSnapshot): PaymentFundsLedgerCase => {
  if (snapshot.unresolvedEvidence) {
    return held('UNRESOLVED_EVIDENCE');
  }
  const collects = snapshot.operations.filter((operation) => operation.kind === 'COLLECT');
  if (collects.some((operation) => operation.outcome === 'CONFLICT')) {
    return held('COLLECTION_IN_CONFLICT');
  }
  const confirmed = collects.filter((operation) => operation.outcome === 'EFFECT_CONFIRMED');
  const [collect] = confirmed;
  if (confirmed.length > 1) {
    return held('INCONSISTENT_EVIDENCE');
  }
  if (collect === undefined) {
    return PaymentFundsLedger.NotCollected({
      liveCollectOperationId: Option.map(
        EffectArray.findFirst(collects, (operation) => operation.outcome !== 'NOT_EFFECTED_CONFIRMED'),
        (operation) => operation.operationId,
      ),
    });
  }
  return establishedLedger(snapshot, collect);
};

export const PAYMENT_PREPAID_SHORTFALL_REASONS = [
  'COLLECTION_NOT_ESTABLISHED',
  'COLLECTION_REDUCED_BY_CORRECTION',
  'CONFIRMED_RETURN_REDUCED_COVERAGE',
  'RETURN_PENDING_OR_INDETERMINATE',
] as const;
export type PaymentPrepaidShortfallReason = (typeof PAYMENT_PREPAID_SHORTFALL_REASONS)[number];

export type PrepaidCoverageDecisionCase = Data.TaggedEnum<{
  /** Exact required collection proven, nothing returned, nothing reserved. */
  Covered: { readonly collectOperationId: string; readonly covered: PaymentMonetaryAmount };
  Held: { readonly reason: PaymentFundsHoldReason };
  NotCovered: { readonly reason: PaymentPrepaidShortfallReason };
  /** Zero payable: no fictitious collection is needed or created (#1148). */
  ZeroPayable: { readonly required: PaymentMonetaryAmount };
}>;
export const PrepaidCoverageDecision = Data.taggedEnum<PrepaidCoverageDecisionCase>();

const establishedPrepaidCoverage = (
  ledger: EstablishedFunds,
  required: PaymentMonetaryAmount,
): PrepaidCoverageDecisionCase => {
  if (ledger.collected.amountMinor > required.amountMinor) {
    return PrepaidCoverageDecision.Held({ reason: 'INCONSISTENT_EVIDENCE' });
  }
  if (ledger.collected.amountMinor < required.amountMinor) {
    return PrepaidCoverageDecision.NotCovered({ reason: 'COLLECTION_REDUCED_BY_CORRECTION' });
  }
  if (!isZeroAmount(ledger.confirmedReturned)) {
    return PrepaidCoverageDecision.NotCovered({ reason: 'CONFIRMED_RETURN_REDUCED_COVERAGE' });
  }
  if (!isZeroAmount(ledger.reserved)) {
    return PrepaidCoverageDecision.NotCovered({ reason: 'RETURN_PENDING_OR_INDETERMINATE' });
  }
  return PrepaidCoverageDecision.Covered({ collectOperationId: ledger.collectOperationId, covered: ledger.collected });
};

/**
 * Current prepaid coverage (#1149 "Payment coverage and Current validity"). Historical existence of a
 * confirmed collection is insufficient: any confirmed or unresolved return makes coverage
 * insufficient, and partial/over-payment evidence is never promoted to the exact required coverage.
 */
export const decidePrepaidCoverage = (snapshot: PaymentFundsSnapshot): PrepaidCoverageDecisionCase => {
  if (isZeroAmount(snapshot.required) && snapshot.operations.length === 0 && !snapshot.unresolvedEvidence) {
    return PrepaidCoverageDecision.ZeroPayable({ required: snapshot.required });
  }
  return PaymentFundsLedger.$match(computePaymentFunds(snapshot), {
    Established: (ledger) => establishedPrepaidCoverage(ledger, snapshot.required),
    Held: ({ reason }) => PrepaidCoverageDecision.Held({ reason }),
    NotCollected: () => PrepaidCoverageDecision.NotCovered({ reason: 'COLLECTION_NOT_ESTABLISHED' }),
  });
};

/**
 * A prepaid proof is Current only at the same coverage revision and while coverage is still
 * sufficient (#1149); a bumped revision means a coverage-affecting change made the proof unusable.
 */
export const isPrepaidProofCurrent = (input: {
  readonly currentCoverageRevision: number;
  readonly decision: PrepaidCoverageDecisionCase;
  readonly proofCoverageRevision: number;
}): boolean =>
  input.proofCoverageRevision === input.currentCoverageRevision &&
  PrepaidCoverageDecision.$is('Covered')(input.decision);

/** A refund reservation request against the funds guard. */
export interface PaymentRefundReservationRequest {
  readonly amount: PaymentMonetaryAmount;
  readonly basisKind: PaymentRefundBasisKind;
}

export type RefundReservationDecisionCase = Data.TaggedEnum<{
  /** Compensation must return exactly the remaining unrefunded collected amount. */
  AmountMismatch: { readonly requiredExact: PaymentMonetaryAmount };
  /** A refund must move a positive amount. */
  AmountNotPositive: { readonly requested: PaymentMonetaryAmount };
  /** Confirmed returns + safe reservations + this request would exceed the established collection. */
  Exceeds: { readonly remaining: PaymentMonetaryAmount };
  Held: { readonly reason: PaymentFundsHoldReason };
  /** No refund before proven collection. */
  NotCollected: { readonly liveCollectOperationId: Option.Option<string> };
  Permitted: {
    readonly collectOperationId: string;
    readonly ledger: EstablishedFunds;
    readonly remainingAfter: PaymentMonetaryAmount;
  };
}>;
export const RefundReservationDecision = Data.taggedEnum<RefundReservationDecisionCase>();

const decideEstablishedReservation = (
  ledger: EstablishedFunds,
  request: PaymentRefundReservationRequest,
): RefundReservationDecisionCase => {
  if (request.basisKind === 'FAILED_COMMITMENT_COMPENSATION') {
    // An overlapping uncertain return is reconciled first; it is never carved out (#1150 B).
    if (!isZeroAmount(ledger.reserved)) {
      return RefundReservationDecision.Held({ reason: 'OVERLAPPING_UNRESOLVED_RETURN' });
    }
    if (isZeroAmount(ledger.remaining)) {
      return RefundReservationDecision.Exceeds({ remaining: ledger.remaining });
    }
    if (request.amount.amountMinor !== ledger.remaining.amountMinor) {
      return RefundReservationDecision.AmountMismatch({ requiredExact: ledger.remaining });
    }
  }
  if (request.amount.amountMinor > ledger.remaining.amountMinor) {
    return RefundReservationDecision.Exceeds({ remaining: ledger.remaining });
  }
  return RefundReservationDecision.Permitted({
    collectOperationId: ledger.collectOperationId,
    ledger,
    remainingAfter: {
      amountMinor: ledger.remaining.amountMinor - request.amount.amountMinor,
      currency: ledger.remaining.currency,
    },
  });
};

/**
 * The Current refundable funds guard (#1150 "Reservation, remaining coverage and concurrency"):
 * confirmedReturned + reserved + requested <= established collection, each counted once.
 */
export const decideRefundReservation = (
  snapshot: PaymentFundsSnapshot,
  request: PaymentRefundReservationRequest,
): RefundReservationDecisionCase => {
  if (isZeroAmount(request.amount)) {
    return RefundReservationDecision.AmountNotPositive({ requested: request.amount });
  }
  return PaymentFundsLedger.$match(computePaymentFunds(snapshot), {
    Established: (ledger) => decideEstablishedReservation(ledger, request),
    Held: ({ reason }) => RefundReservationDecision.Held({ reason }),
    NotCollected: ({ liveCollectOperationId }) => RefundReservationDecision.NotCollected({ liveCollectOperationId }),
  });
};

/** Effect form of the guard: succeeds with the permitted decision or fails with its typed refusal. */
export const requireRefundReservation = (
  snapshot: PaymentFundsSnapshot,
  request: PaymentRefundReservationRequest,
): Effect.Effect<
  Data.TaggedEnum.Value<RefundReservationDecisionCase, 'Permitted'>,
  PaymentConflict | PaymentRejected
> =>
  RefundReservationDecision.$match(decideRefundReservation(snapshot, request), {
    AmountMismatch: ({ requiredExact }) =>
      Effect.fail(
        paymentRejected(
          'payment_refund_amount_mismatch',
          `Compensation must return exactly the remaining ${requiredExact.amountMinor} minor units`,
        ),
      ),
    AmountNotPositive: () =>
      Effect.fail(paymentRejected('payment_amount_invalid', 'A refund must move a positive amount')),
    Exceeds: () =>
      Effect.fail(
        paymentConflict('payment_refundable_funds_exceeded', 'The refund exceeds the Current refundable funds'),
      ),
    Held: ({ reason }) =>
      Effect.fail(
        paymentConflict('payment_held_for_reconciliation', `Refundable funds are held for reconciliation: ${reason}`),
      ),
    NotCollected: () =>
      Effect.fail(paymentRejected('payment_no_established_collection', 'No proven collection exists for this Payment')),
    Permitted: (permitted) => Effect.succeed(permitted),
  });

/**
 * Item atomicity (#1150 A): the requested amount must equal the exact sum of the complete supplied
 * items, all in the original currency. Fractions, percentages and Payment-made subdivisions fail.
 */
export const requireExactRefundableItemsAmount = (
  basis: PaymentRefundableItemsBasis,
  requested: PaymentMonetaryAmount,
): Result.Result<PaymentMonetaryAmount, PaymentRejected> =>
  Result.flatMap(sumAmounts(basis.items, requested.currency), (total) =>
    total.amountMinor === requested.amountMinor
      ? Result.succeed(total)
      : Result.fail(
          paymentRejected(
            'payment_refund_item_fractioned',
            'The refund amount must equal the full authoritative amount of the selected items',
          ),
        ),
  );

/** One refund item reservation row joined with its operation outcome. */
export interface PaymentRefundItemClaimView {
  readonly active: boolean;
  readonly itemRef: string;
  readonly operationOutcome: PaymentOperationOutcome;
}

/**
 * Payment-owned availability of one authoritative item (#1150): REFUNDED when a confirmed refund
 * holds it, RESERVED while a live/unknown/conflicting refund holds it, otherwise AVAILABLE.
 */
export const refundItemAvailability = (
  claims: readonly PaymentRefundItemClaimView[],
  itemRef: string,
): PaymentRefundableItemAvailability => {
  let reserved = false;
  for (const claim of claims) {
    if (claim.active && claim.itemRef === itemRef) {
      if (claim.operationOutcome === 'EFFECT_CONFIRMED') {
        return 'REFUNDED';
      }
      reserved ||= isUnresolvedOutcome(claim.operationOutcome);
    }
  }
  return reserved ? 'RESERVED_BY_PENDING_REFUND' : 'AVAILABLE';
};
