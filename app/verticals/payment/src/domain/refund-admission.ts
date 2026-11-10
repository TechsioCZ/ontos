import { DateTime, Match, Option, Result } from 'effect';
import type { Schema } from 'effect';

import type { PaymentConflict, PaymentConflictCode } from '../../shared/domain/payment-conflict.ts';
import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import type {
  PaymentFailedCommitmentCompensationBasis,
  PaymentRefundableItem,
  PaymentRefundableItemsBasis,
  PaymentRefundBasis,
} from '../../shared/domain/payment-refund-basis.ts';
import type { PaymentRejected, PaymentRejectionCode } from '../../shared/domain/payment-rejected.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentRefundableItemAvailability } from '../../shared/domain/payment-vocabulary.ts';
import { paymentCancellationConflict } from '../../shared/domain/refund-cancellation-conflict.ts';
import type { PaymentCancellationConflictCode } from '../../shared/domain/refund-cancellation-conflict.ts';
import { paymentCancellationRejected } from '../../shared/domain/refund-cancellation-rejected.ts';
import type { PaymentCancellationRejectionCode } from '../../shared/domain/refund-cancellation-rejected.ts';
import { paymentCancellationUnavailable } from '../../shared/domain/refund-cancellation-unavailable.ts';
import { paymentRefundConflict } from '../../shared/domain/refund-conflict.ts';
import type { PaymentRefundConflict, PaymentRefundConflictCode } from '../../shared/domain/refund-conflict.ts';
import type { PaymentCancellationFailure, PaymentRefundFailure } from '../../shared/domain/refund-contract.ts';
import { paymentRefundRejected } from '../../shared/domain/refund-rejected.ts';
import type { PaymentRefundRejected, PaymentRefundRejectionCode } from '../../shared/domain/refund-rejected.ts';
import { paymentRefundUnavailable } from '../../shared/domain/refund-unavailable.ts';
import type { PaymentRefundUnavailable } from '../../shared/domain/refund-unavailable.ts';
import type { OutboxPayload } from '../../shared/outbox/payment-core-operation-requested-v1.ts';
import type { PaymentAggregateRecord, PaymentOperationRecord } from '../persistence/payment-aggregate-persistence.ts';
import type { PaymentCommitmentOutcome } from '../ports/commitment-outcome-port.ts';
import type { PaymentOwnerEvidenceUnavailable } from '../ports/owner-evidence-unavailable.ts';
import type { PaymentRefundableItemVerification } from '../ports/refundable-items-port.ts';
import { refundItemAvailability } from './coverage.ts';

/**
 * Pure admission rules of cancellation and refund requests (#1150). Funds are decided only by the
 * shared calculator in `coverage.ts`; this module adds the request material, owner-evidence checks,
 * item reservations and the typed public refusals.
 */

const compareText = (left: string, right: string) => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

const sortedItems = (basis: PaymentRefundableItemsBasis): PaymentRefundableItemsBasis => {
  const [first, ...rest] = basis.items.toSorted((left, right) => compareText(left.itemRef, right.itemRef));
  return first === undefined ? basis : { ...basis, items: [first, ...rest] };
};

/** The one stored basis: items are kept in a canonical order so a reordered request is the same basis. */
export const canonicalRefundBasis = (basis: PaymentRefundBasis): PaymentRefundBasis =>
  Match.valueTags(basis, {
    FAILED_COMMITMENT_COMPENSATION: (compensation): PaymentRefundBasis => compensation,
    REFUNDABLE_ITEMS: (items): PaymentRefundBasis => sortedItems(items),
  });

const itemMaterial = (item: PaymentRefundableItem): Schema.Json => ({
  amountMinor: item.amountMinor,
  currency: item.currency,
  itemRef: item.itemRef,
  sourceEvidenceRef: item.sourceEvidenceRef,
});

const basisMaterial = (basis: PaymentRefundBasis): Schema.Json =>
  Match.valueTags(basis, {
    FAILED_COMMITMENT_COMPENSATION: (compensation): Schema.Json => ({
      _tag: compensation._tag,
      attemptRef: compensation.attemptRef,
      closedAgainstLateCommit: compensation.closedAgainstLateCommit,
      terminalNonCommitEvidenceRef: compensation.terminalNonCommitEvidenceRef,
    }),
    REFUNDABLE_ITEMS: (items): Schema.Json => ({
      _tag: items._tag,
      items: sortedItems(items).items.map(itemMaterial),
    }),
  });

/** Canonical material request of one REFUND; its hash is the business replay comparator (#1151). */
export const refundMaterialRequest = (request: {
  readonly amount: PaymentMonetaryAmount;
  readonly basis: PaymentRefundBasis;
  readonly reason: string;
}): Schema.Json => ({
  amountMinor: request.amount.amountMinor,
  basis: basisMaterial(request.basis),
  currency: request.amount.currency,
  kind: 'REFUND',
  reason: request.reason,
});

/** Canonical material request of one CANCEL_OR_VOID of an exact COLLECT. */
export const cancellationMaterialRequest = (request: {
  readonly reason: string;
  readonly targetOperationId: string;
}): Schema.Json => ({
  kind: 'CANCEL_OR_VOID',
  reason: request.reason,
  targetOperationId: request.targetOperationId,
});

export interface UnavailableRefundItem {
  /** HELD_FOR_RECONCILIATION: two refunds that are not definitively non-executed stand for one item. */
  readonly availability: Exclude<PaymentRefundableItemAvailability, 'AVAILABLE'> | 'HELD_FOR_RECONCILIATION';
  readonly itemRef: string;
}

/**
 * The items each REFUND still stands for: its immutable basis, unless definitive non-execution is its
 * Current outcome. A refund whose non-execution is later overturned (CONFLICT, then possibly
 * EFFECT_CONFIRMED) protects its items again although its released claim rows stay history (#1150).
 */
const refundItemProtections = (aggregate: PaymentAggregateRecord) =>
  aggregate.operations.flatMap((operation) => {
    const { refundBasis } = operation;
    if (operation.kind !== 'REFUND' || operation.outcome === 'NOT_EFFECTED_CONFIRMED' || refundBasis === undefined) {
      return [];
    }
    const items = Match.valueTags(refundBasis, {
      FAILED_COMMITMENT_COMPENSATION: (): readonly PaymentRefundableItem[] => [],
      REFUNDABLE_ITEMS: (basis): readonly PaymentRefundableItem[] => basis.items,
    });
    return items.map((item) => ({
      active: true,
      itemRef: item.itemRef,
      operationId: operation.operationId,
      operationOutcome: operation.outcome,
    }));
  });

const findOverlap = (protections: ReturnType<typeof refundItemProtections>): Option.Option<UnavailableRefundItem> => {
  const standingFor = new Map<string, string>();
  for (const protection of protections) {
    const holder = standingFor.get(protection.itemRef);
    if (holder !== undefined && holder !== protection.operationId) {
      return Option.some({ availability: 'HELD_FOR_RECONCILIATION', itemRef: protection.itemRef });
    }
    standingFor.set(protection.itemRef, protection.operationId);
  }
  return Option.none();
};

/**
 * Two refunds standing for the same item (one was overturned after the item was legitimately
 * reclaimed) are an ambiguous overlap: every new return of either basis is held for reconciliation
 * rather than double returned or computed from invented funds (#1150 coverage).
 */
export const findHeldRefundItemOverlap = (aggregate: PaymentAggregateRecord): Option.Option<UnavailableRefundItem> =>
  findOverlap(refundItemProtections(aggregate));

/**
 * An item reserved by a live/unknown refund or already refunded cannot be selected again, and an
 * ambiguous item overlap holds every new item refund.
 */
export const findUnavailableRefundItem = (
  aggregate: PaymentAggregateRecord,
  itemRefs: readonly string[],
): Option.Option<UnavailableRefundItem> => {
  const protections = refundItemProtections(aggregate);
  const overlap = findOverlap(protections);
  if (Option.isSome(overlap)) {
    return overlap;
  }
  for (const itemRef of itemRefs) {
    const availability = refundItemAvailability(protections, itemRef);
    if (availability !== 'AVAILABLE') {
      return Option.some({ availability, itemRef });
    }
  }
  return Option.none();
};

export const refundItemUnavailableConflict = (unavailable: UnavailableRefundItem): PaymentRefundConflict =>
  Match.value(unavailable.availability).pipe(
    Match.when('REFUNDED', () =>
      paymentRefundConflict('payment_refund_item_refunded', `Item ${unavailable.itemRef} is already refunded`),
    ),
    Match.when('RESERVED_BY_PENDING_REFUND', () =>
      paymentRefundConflict(
        'payment_refund_item_reserved',
        `Item ${unavailable.itemRef} is reserved by a pending or unresolved refund`,
      ),
    ),
    Match.when('HELD_FOR_RECONCILIATION', () =>
      paymentRefundConflict(
        'payment_held_for_reconciliation',
        `Item ${unavailable.itemRef} is held by more than one refund; new returns wait for reconciliation`,
      ),
    ),
    Match.exhaustive,
  );

const offContractItemsAnswer = (reason: string) =>
  Result.fail(paymentRefundUnavailable('payment_owner_evidence_unavailable', reason));

/** Exact equality with the authoritative item; a smaller amount is a Payment-made fraction. */
const compareWithAuthoritative = (
  item: PaymentRefundableItem,
  authoritative: PaymentRefundableItem,
): Result.Result<void, PaymentRefundRejected> => {
  if (item.amountMinor < authoritative.amountMinor && item.currency === authoritative.currency) {
    return Result.fail(
      paymentRefundRejected(
        'payment_refund_item_fractioned',
        `Item ${item.itemRef} is atomic: only its full authoritative amount can be refunded`,
      ),
    );
  }
  return item.amountMinor === authoritative.amountMinor &&
    item.currency === authoritative.currency &&
    item.sourceEvidenceRef === authoritative.sourceEvidenceRef
    ? Result.void
    : Result.fail(
        paymentRefundRejected(
          'payment_refund_item_mismatch',
          `Item ${item.itemRef} differs from its authoritative item`,
        ),
      );
};

const verifyOneItem = (
  item: PaymentRefundableItem,
  verdict: PaymentRefundableItemVerification,
): Result.Result<void, PaymentRefundRejected | PaymentRefundUnavailable> =>
  Match.valueTags(verdict, {
    NOT_REFUNDABLE: (refused): Result.Result<void, PaymentRefundRejected | PaymentRefundUnavailable> =>
      refused.itemRef === item.itemRef
        ? Result.fail(
            paymentRefundRejected('payment_refund_item_not_refundable', `Item ${item.itemRef} is ${refused.reason}`),
          )
        : offContractItemsAnswer('The refundable-items owner answered for a different item'),
    REFUNDABLE: (refundable): Result.Result<void, PaymentRefundRejected | PaymentRefundUnavailable> =>
      refundable.item.itemRef === item.itemRef
        ? compareWithAuthoritative(item, refundable.item)
        : offContractItemsAnswer('The refundable-items owner answered for a different item'),
  });

/**
 * Every supplied item must be the exact complete authoritative item of its owner (#1150 A): an
 * item that is not refundable, a smaller (fractioned) amount or different evidence is refused. An
 * owner answer outside its public contract is unavailable evidence, never a negative fact.
 */
export const verifyAuthoritativeRefundableItems = (
  basis: PaymentRefundableItemsBasis,
  verdicts: readonly PaymentRefundableItemVerification[],
): Result.Result<void, PaymentRefundRejected | PaymentRefundUnavailable> => {
  if (verdicts.length !== basis.items.length) {
    return offContractItemsAnswer('The refundable-items owner did not answer for every selected item');
  }
  for (const [index, item] of basis.items.entries()) {
    const verdict = verdicts[index];
    const verified =
      verdict === undefined
        ? offContractItemsAnswer('The refundable-items owner did not answer for every selected item')
        : verifyOneItem(item, verdict);
    if (Result.isFailure(verified)) {
      return verified;
    }
  }
  return Result.void;
};

/**
 * Failed-commitment compensation needs authoritative terminal non-commit plus closure against late
 * commit for the exact Attempt and evidence (#1150 B). Timeout, unknown or open outcomes never do.
 */
export const verifyCompensationEvidence = (
  basis: PaymentFailedCommitmentCompensationBasis,
  outcome: PaymentCommitmentOutcome,
): Result.Result<void, PaymentRefundRejected> =>
  Match.valueTags(outcome, {
    NOT_COMMITTED_CLOSED: (closed): Result.Result<void, PaymentRefundRejected> =>
      closed.attemptRef === basis.attemptRef &&
      closed.terminalNonCommitEvidenceRef === basis.terminalNonCommitEvidenceRef
        ? Result.void
        : Result.fail(
            paymentRefundRejected(
              'payment_compensation_not_established',
              'The terminal non-commit evidence does not prove the exact requested Attempt',
            ),
          ),
    NOT_ESTABLISHED: (open): Result.Result<void, PaymentRefundRejected> =>
      Result.fail(
        paymentRefundRejected(
          'payment_compensation_not_established',
          `Terminal non-commit is not established for the Attempt: ${open.reason}`,
        ),
      ),
  });

const REFUND_CONFLICT_CODE_BY_PAYMENT_CONFLICT = {
  payment_aggregate_version_conflict: 'payment_aggregate_version_conflict',
  // A REFUND never opens a collection lineage or a Payment identity; seen here, the aggregate moved.
  payment_collect_lineage_conflict: 'payment_aggregate_version_conflict',
  payment_held_for_reconciliation: 'payment_held_for_reconciliation',
  payment_identity_conflict: 'payment_aggregate_version_conflict',
  payment_intent_material_conflict: 'payment_aggregate_version_conflict',
  payment_operation_material_conflict: 'payment_operation_material_conflict',
  payment_refund_item_reserved: 'payment_refund_item_reserved',
  payment_refundable_funds_exceeded: 'payment_refundable_funds_exceeded',
} as const satisfies Record<PaymentConflictCode, PaymentRefundConflictCode>;

const REFUND_REJECTION_CODE_BY_PAYMENT_REJECTION = {
  payment_amount_invalid: 'payment_amount_invalid',
  payment_currency_mismatch: 'payment_currency_mismatch',
  // Not reachable for a REFUND request; never widened into a different public meaning.
  payment_method_binding_mismatch: 'payment_refund_basis_invalid',
  payment_no_established_collection: 'payment_no_established_collection',
  payment_not_found: 'payment_not_found',
  payment_operation_not_found: 'payment_refund_basis_invalid',
  payment_outcome_transition_illegal: 'payment_refund_basis_invalid',
  payment_refund_amount_mismatch: 'payment_refund_amount_mismatch',
  payment_refund_basis_invalid: 'payment_refund_basis_invalid',
  payment_refund_item_fractioned: 'payment_refund_item_fractioned',
} as const satisfies Record<PaymentRejectionCode, PaymentRefundRejectionCode>;

/** Projects a foundation failure onto the exact public refund refusal. */
export const refundFailureOf = (
  failure: PaymentConflict | PaymentRejected | PaymentUnavailable | PaymentOwnerEvidenceUnavailable,
): PaymentRefundFailure =>
  Match.valueTags(failure, {
    PaymentConflict: (conflict): PaymentRefundFailure =>
      paymentRefundConflict(REFUND_CONFLICT_CODE_BY_PAYMENT_CONFLICT[conflict.code], conflict.reason),
    PaymentOwnerEvidenceUnavailable: (unavailable): PaymentRefundFailure =>
      paymentRefundUnavailable('payment_owner_evidence_unavailable', unavailable.reason),
    PaymentRejected: (rejected): PaymentRefundFailure =>
      paymentRefundRejected(REFUND_REJECTION_CODE_BY_PAYMENT_REJECTION[rejected.code], rejected.reason),
    PaymentUnavailable: (unavailable): PaymentRefundFailure =>
      paymentRefundUnavailable('payment_unavailable', unavailable.reason),
  });

const CANCELLATION_CONFLICT_CODE_BY_PAYMENT_CONFLICT = {
  payment_aggregate_version_conflict: 'payment_aggregate_version_conflict',
  payment_collect_lineage_conflict: 'payment_aggregate_version_conflict',
  payment_held_for_reconciliation: 'payment_held_for_reconciliation',
  payment_identity_conflict: 'payment_aggregate_version_conflict',
  payment_intent_material_conflict: 'payment_aggregate_version_conflict',
  payment_operation_material_conflict: 'payment_operation_material_conflict',
  payment_refund_item_reserved: 'payment_aggregate_version_conflict',
  payment_refundable_funds_exceeded: 'payment_aggregate_version_conflict',
} as const satisfies Record<PaymentConflictCode, PaymentCancellationConflictCode>;

const CANCELLATION_REJECTION_CODE_BY_PAYMENT_REJECTION = {
  payment_amount_invalid: 'payment_cancellation_target_invalid',
  payment_currency_mismatch: 'payment_cancellation_target_invalid',
  payment_method_binding_mismatch: 'payment_cancellation_target_invalid',
  payment_no_established_collection: 'payment_cancellation_target_invalid',
  payment_not_found: 'payment_not_found',
  payment_operation_not_found: 'payment_operation_not_found',
  payment_outcome_transition_illegal: 'payment_cancellation_target_invalid',
  payment_refund_amount_mismatch: 'payment_cancellation_target_invalid',
  payment_refund_basis_invalid: 'payment_cancellation_target_invalid',
  payment_refund_item_fractioned: 'payment_cancellation_target_invalid',
} as const satisfies Record<PaymentRejectionCode, PaymentCancellationRejectionCode>;

/** Projects a foundation failure onto the exact public cancellation refusal. */
export const cancellationFailureOf = (
  failure: PaymentConflict | PaymentRejected | PaymentUnavailable,
): PaymentCancellationFailure =>
  Match.valueTags(failure, {
    PaymentConflict: (conflict): PaymentCancellationFailure =>
      paymentCancellationConflict(CANCELLATION_CONFLICT_CODE_BY_PAYMENT_CONFLICT[conflict.code], conflict.reason),
    PaymentRejected: (rejected): PaymentCancellationFailure =>
      paymentCancellationRejected(CANCELLATION_REJECTION_CODE_BY_PAYMENT_REJECTION[rejected.code], rejected.reason),
    PaymentUnavailable: (unavailable): PaymentCancellationFailure => paymentCancellationUnavailable(unavailable.reason),
  });

/** Why the Current outcome of the target collection forbids a cancellation, if it does. */
const refusalForTargetOutcome = (target: PaymentOperationRecord): Option.Option<PaymentCancellationFailure> =>
  Match.value(target.outcome).pipe(
    Match.when('EFFECT_CONFIRMED', (): Option.Option<PaymentCancellationFailure> =>
      Option.some(
        paymentCancellationRejected(
          'payment_cancellation_after_collection',
          'Collection is proven; returning the funds requires a REFUND on an accepted basis',
        ),
      ),
    ),
    Match.when('NOT_EFFECTED_CONFIRMED', (): Option.Option<PaymentCancellationFailure> =>
      Option.some(
        paymentCancellationRejected(
          'payment_cancellation_target_not_live',
          'The collection is definitively not effected',
        ),
      ),
    ),
    Match.when('CONFLICT', (): Option.Option<PaymentCancellationFailure> =>
      Option.some(
        paymentCancellationConflict(
          'payment_held_for_reconciliation',
          'The collection outcome is in conflict and held for reconciliation',
        ),
      ),
    ),
    Match.whenOr('PENDING', 'INDETERMINATE', (): Option.Option<PaymentCancellationFailure> => Option.none()),
    Match.exhaustive,
  );

/**
 * CANCEL_OR_VOID only stops a collection whose effect is not yet established (#1150). A proven
 * collection needs a REFUND; a definitively not-effected collection has nothing to stop; a second
 * cancellation cannot escape an unresolved one.
 */
export const decideCancellationTarget = (
  operations: readonly PaymentOperationRecord[],
  targetOperationId: string,
): Result.Result<PaymentOperationRecord, PaymentCancellationFailure> => {
  const target = operations.find((operation) => operation.operationId === targetOperationId);
  if (target === undefined) {
    return Result.fail(
      paymentCancellationRejected('payment_operation_not_found', 'The target operation does not exist on this Payment'),
    );
  }
  if (target.kind !== 'COLLECT') {
    return Result.fail(
      paymentCancellationRejected(
        'payment_cancellation_target_invalid',
        'Only a collection can be cancelled or voided',
      ),
    );
  }
  const refusal = refusalForTargetOutcome(target);
  if (Option.isSome(refusal)) {
    return Result.fail(refusal.value);
  }
  const unresolved = operations.some(
    (operation) =>
      operation.kind === 'CANCEL_OR_VOID' &&
      operation.targetOperationId === target.operationId &&
      operation.outcome !== 'NOT_EFFECTED_CONFIRMED',
  );
  return unresolved
    ? Result.fail(
        paymentCancellationConflict(
          'payment_cancellation_in_progress',
          'A cancellation of this collection is already live or unresolved',
        ),
      )
    : Result.succeed(target);
};

/**
 * The durable execution request of a new CANCEL_OR_VOID or REFUND (`payment.core.operation-requested.v1`)
 * with the operation's original immutable binding; it is emitted once, when the operation is created.
 * The caller adds the targeted COLLECT and, for a REFUND, its one immutable basis.
 */
export const operationRequestedPayloadOf = (
  aggregate: PaymentAggregateRecord,
  operation: PaymentOperationRecord,
): OutboxPayload => ({
  amount: operation.amount,
  binding: operation.binding,
  kind: operation.kind,
  materialHash: operation.materialHash,
  method: aggregate.payment.method,
  operationId: operation.operationId,
  operationKey: operation.operationKey,
  paymentId: operation.paymentId,
  provenance: operation.provenance,
  purchaseCorrelationId: aggregate.payment.purchaseCorrelationId,
  requestedAt: DateTime.formatIso(operation.createdAt),
});
