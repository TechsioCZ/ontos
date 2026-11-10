import { DateTime, Effect, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { PaymentRefundableItem, PaymentRefundBasis } from '../../shared/domain/payment-refund-basis.ts';
import { PaymentConflict } from '../../shared/domain/payment-conflict.ts';
import { PaymentRejected } from '../../shared/domain/payment-rejected.ts';
import { PaymentCancellationConflict } from '../../shared/domain/refund-cancellation-conflict.ts';
import { PaymentRefundConflict } from '../../shared/domain/refund-conflict.ts';
import { PaymentRefundRejected } from '../../shared/domain/refund-rejected.ts';
import type { PaymentRefundExecutionRoute } from '../../shared/domain/refund-contract.ts';
import { PaymentRefundUnavailable } from '../../shared/domain/refund-unavailable.ts';
import {
  canonicalRefundBasis,
  cancellationFailureOf,
  decideCancellationTarget,
  refundFailureOf,
  refundMaterialRequest,
  verifyAuthoritativeRefundableItems,
  verifyCompensationEvidence,
} from '../../src/domain/refund-admission.ts';
import { computePaymentMaterialHash } from '../../src/persistence/payment-aggregate-persistence.ts';
import type { PaymentOperationRecord } from '../../src/persistence/payment-aggregate-persistence.ts';
import { ownerEvidenceUnavailable } from '../../src/ports/owner-evidence-unavailable.ts';
import type { PaymentOperationKind, PaymentOperationOutcome } from '../../shared/domain/payment-vocabulary.ts';

/** #1150 pure admission rules: one immutable basis, atomic items, exact owner evidence, cancellation. */

const item = (itemRef: string, amountMinor: number): PaymentRefundableItem => ({
  amountMinor,
  currency: 'CZK',
  itemRef,
  sourceEvidenceRef: `order-line-${itemRef}`,
});
const itemsBasis = (...items: readonly [PaymentRefundableItem, ...PaymentRefundableItem[]]): PaymentRefundBasis => ({
  _tag: 'REFUNDABLE_ITEMS',
  items,
});
const compensation = {
  _tag: 'FAILED_COMMITMENT_COMPENSATION',
  attemptRef: 'attempt-1',
  closedAgainstLateCommit: true,
  terminalNonCommitEvidenceRef: 'closure-1',
} as const;

const failureCode = <A, E extends { readonly code: string }>(result: Result.Result<A, E>) =>
  Result.isFailure(result) ? result.failure.code : 'ok';

const operation = (
  operationId: string,
  kind: PaymentOperationKind,
  outcome: PaymentOperationOutcome,
  targetOperationId?: string,
): PaymentOperationRecord => ({
  amount: { amountMinor: 100_000, currency: 'CZK' },
  binding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
  createdAt: DateTime.makeUnsafe(0),
  kind,
  materialHash: 'a'.repeat(64),
  materialRequest: {},
  operationId,
  operationKey: operationId,
  outcome,
  outcomeRevision: 1,
  paymentId: 'payment-1',
  provenance: { actionInvocationId: 'invocation', actorPrincipalId: 'principal', compositionRevision: 'c'.repeat(64) },
  refundBasis: Option.getOrUndefined(Option.none<PaymentRefundBasis>()),
  refundExecutionRoute: Option.getOrUndefined(Option.none<PaymentRefundExecutionRoute>()),
  targetOperationId,
});

describe('#1150 refund request material', () => {
  it.effect('#1150 a reordered item selection is the same immutable basis and the same operation', () =>
    Effect.gen(function* sameMaterial() {
      const forward = itemsBasis(item('A', 100), item('B', 200));
      const reversed = itemsBasis(item('B', 200), item('A', 100));
      expect(canonicalRefundBasis(reversed)).toEqual(forward);
      const request = { amount: { amountMinor: 300, currency: 'CZK' as const }, reason: 'Returned' };
      const [left, right, mutated] = yield* Effect.all(
        [
          computePaymentMaterialHash(refundMaterialRequest({ ...request, basis: forward })),
          computePaymentMaterialHash(refundMaterialRequest({ ...request, basis: reversed })),
          computePaymentMaterialHash(refundMaterialRequest({ ...request, basis: compensation })),
        ],
        { concurrency: 1 },
      );
      expect(left).toBe(right);
      // Switching the basis under the same key is a different material request (a conflict).
      expect(mutated).not.toBe(left);
    }),
  );
});

describe('#1150 authoritative refundable items', () => {
  it('#1150 complete authoritative items pass; fractions, mismatches and refusals do not', () => {
    const basis = { _tag: 'REFUNDABLE_ITEMS', items: [item('A', 500)] } as const;
    expect(failureCode(verifyAuthoritativeRefundableItems(basis, [{ _tag: 'REFUNDABLE', item: item('A', 500) }]))).toBe(
      'ok',
    );
    expect(
      failureCode(verifyAuthoritativeRefundableItems(basis, [{ _tag: 'REFUNDABLE', item: item('A', 1000) }])),
    ).toBe('payment_refund_item_fractioned');
    expect(
      failureCode(
        verifyAuthoritativeRefundableItems(basis, [
          { _tag: 'REFUNDABLE', item: { ...item('A', 500), sourceEvidenceRef: 'another-line' } },
        ]),
      ),
    ).toBe('payment_refund_item_mismatch');
    expect(
      failureCode(
        verifyAuthoritativeRefundableItems(basis, [
          { _tag: 'NOT_REFUNDABLE', itemRef: 'A', reason: 'ITEM_NOT_REFUNDABLE' },
        ]),
      ),
    ).toBe('payment_refund_item_not_refundable');
  });

  it('#1150 an owner answer outside its contract is unavailable evidence, never a negative fact', () => {
    const basis = { _tag: 'REFUNDABLE_ITEMS', items: [item('A', 500), item('B', 500)] } as const;
    expect(failureCode(verifyAuthoritativeRefundableItems(basis, [{ _tag: 'REFUNDABLE', item: item('A', 500) }]))).toBe(
      'payment_owner_evidence_unavailable',
    );
    expect(
      failureCode(
        verifyAuthoritativeRefundableItems(basis, [
          { _tag: 'REFUNDABLE', item: item('B', 500) },
          { _tag: 'REFUNDABLE', item: item('A', 500) },
        ]),
      ),
    ).toBe('payment_owner_evidence_unavailable');
  });
});

describe('#1150 failed-commitment compensation evidence', () => {
  it('#1150 only exact terminal non-commit plus closure establishes the basis', () => {
    expect(
      failureCode(
        verifyCompensationEvidence(compensation, {
          _tag: 'NOT_COMMITTED_CLOSED',
          attemptRef: 'attempt-1',
          terminalNonCommitEvidenceRef: 'closure-1',
        }),
      ),
    ).toBe('ok');
    for (const reason of [
      'OUTCOME_UNKNOWN',
      'ATTEMPT_OPEN',
      'NOT_CLOSED_AGAINST_LATE_COMMIT',
      'ORDER_COMMITTED',
    ] as const) {
      expect(
        failureCode(
          verifyCompensationEvidence(compensation, { _tag: 'NOT_ESTABLISHED', attemptRef: 'attempt-1', reason }),
        ),
      ).toBe('payment_compensation_not_established');
    }
    expect(
      failureCode(
        verifyCompensationEvidence(compensation, {
          _tag: 'NOT_COMMITTED_CLOSED',
          attemptRef: 'attempt-2',
          terminalNonCommitEvidenceRef: 'closure-1',
        }),
      ),
    ).toBe('payment_compensation_not_established');
  });
});

const decide = (operations: readonly PaymentOperationRecord[], target = 'collect') =>
  failureCode(decideCancellationTarget(operations, target));

describe('#1150 cancellation target', () => {
  it('#1150 cancellation only stops a live or unknown collection of the same Payment', () => {
    expect(decide([operation('collect', 'COLLECT', 'PENDING')])).toBe('ok');
    expect(decide([operation('collect', 'COLLECT', 'INDETERMINATE')])).toBe('ok');
    expect(decide([operation('collect', 'COLLECT', 'EFFECT_CONFIRMED')])).toBe('payment_cancellation_after_collection');
    expect(decide([operation('collect', 'COLLECT', 'NOT_EFFECTED_CONFIRMED')])).toBe(
      'payment_cancellation_target_not_live',
    );
    expect(decide([operation('collect', 'COLLECT', 'CONFLICT')])).toBe('payment_held_for_reconciliation');
    expect(decide([operation('refund', 'REFUND', 'PENDING', 'collect')], 'refund')).toBe(
      'payment_cancellation_target_invalid',
    );
    expect(decide([], 'missing')).toBe('payment_operation_not_found');
    expect(
      decide([
        operation('collect', 'COLLECT', 'PENDING'),
        operation('cancel', 'CANCEL_OR_VOID', 'INDETERMINATE', 'collect'),
      ]),
    ).toBe('payment_cancellation_in_progress');
    expect(
      decide([
        operation('collect', 'COLLECT', 'PENDING'),
        operation('cancel', 'CANCEL_OR_VOID', 'NOT_EFFECTED_CONFIRMED', 'collect'),
      ]),
    ).toBe('ok');
  });
});

describe('#1150 foundation failures become exact public refusals', () => {
  it('#1150 refund and cancellation failures keep their meaning', () => {
    const reserved = refundFailureOf(new PaymentConflict({ code: 'payment_refund_item_reserved', reason: 'race' }));
    const missing = refundFailureOf(new PaymentRejected({ code: 'payment_not_found', reason: 'scope' }));
    const ownerDown = refundFailureOf(ownerEvidenceUnavailable('REFUNDABLE_ITEMS', 'down'));
    const material = cancellationFailureOf(
      new PaymentConflict({ code: 'payment_operation_material_conflict', reason: 'key' }),
    );
    expect(Schema.is(PaymentRefundConflict)(reserved) && reserved.code).toBe('payment_refund_item_reserved');
    expect(Schema.is(PaymentRefundRejected)(missing) && missing.code).toBe('payment_not_found');
    expect(Schema.is(PaymentRefundUnavailable)(ownerDown) && ownerDown.code).toBe('payment_owner_evidence_unavailable');
    expect(Schema.is(PaymentCancellationConflict)(material) && material.code).toBe(
      'payment_operation_material_conflict',
    );
  });
});
