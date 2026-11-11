import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Layer, Predicate } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { mapRequestPaymentCancellationActionProblem } from '../../api/request-payment-cancellation-action-problems.ts';
import { mapRequestPaymentRefundActionProblem } from '../../api/request-payment-refund-action-problems.ts';
import { paymentCancellationConflict } from '../../shared/domain/refund-cancellation-conflict.ts';
import { paymentCancellationRejected } from '../../shared/domain/refund-cancellation-rejected.ts';
import { paymentCancellationUnavailable } from '../../shared/domain/refund-cancellation-unavailable.ts';
import { paymentRefundConflict } from '../../shared/domain/refund-conflict.ts';
import { paymentRefundRejected } from '../../shared/domain/refund-rejected.ts';
import { paymentRefundUnavailable } from '../../shared/domain/refund-unavailable.ts';
import { requestPaymentCancellationAction } from '../../src/actions/request-payment-cancellation.action.ts';
import { requestPaymentRefundAction } from '../../src/actions/request-payment-refund.action.ts';
import { CommitmentOutcomePort, unavailableCommitmentOutcome } from '../../src/ports/commitment-outcome-port.ts';
import { RefundableItemsPort, unavailableRefundableItems } from '../../src/ports/refundable-items-port.ts';
import { paymentRegistration } from '../../vertical.registration.ts';

/**
 * #1150 refund and cancellation writes at the real Core Action boundary: the registered descriptors
 * are `write` entrypoints, so every non-active Module State denies them before owner work, and each
 * typed Payment refusal maps to its exact HTTP Problem.
 */

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000001150',
  authContextRef: 'better-auth-session:payment-refund-boundary',
  authMethod: 'session',
  legalEntityId: '30000000-0000-4000-8000-000000001150',
  principalId: '20000000-0000-4000-8000-000000001150',
  tenantId: '40000000-0000-4000-8000-000000001150',
} as const;

const refundPayload = {
  amount: { amountMinor: 30_000, currency: 'CZK' },
  basis: {
    _tag: 'REFUNDABLE_ITEMS',
    items: [{ amountMinor: 30_000, currency: 'CZK', itemRef: 'B', sourceEvidenceRef: 'order-line-B' }],
  },
  operationKey: 'refund-b',
  paymentId: '50000000-0000-4000-8000-000000001150',
  reason: 'Customer returned the item',
} as const;

const cancellationPayload = {
  operationKey: 'cancel-1',
  paymentId: '50000000-0000-4000-8000-000000001150',
  reason: 'Customer abandoned the checkout',
  targetOperationId: '60000000-0000-4000-8000-000000001150',
} as const;

// The denial gates fire before any owner work; the owner ports stay fail-closed.
const failClosedOwners = Layer.mergeAll(
  Layer.succeed(RefundableItemsPort, unavailableRefundableItems),
  Layer.succeed(CommitmentOutcomePort, unavailableCommitmentOutcome),
);

const NON_ACTIVE_STATES = ['inactive', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'] as const;

describe('#1150 denied writes in non-active Module States', () => {
  for (const moduleState of NON_ACTIVE_STATES) {
    it.effect(`#1150 request-payment-refund and request-payment-cancellation are denied while ${moduleState}`, () =>
      Effect.gen(function* denyRefundWrites() {
        const harness = yield* makeActionTestHarness({
          access: 'allowed',
          moduleState,
          ownerRegistration: paymentRegistration,
        });
        const refund = yield* harness.runtime
          .runAction({
            payload: refundPayload,
            principal,
            registration: requestPaymentRefundAction,
            transport: { correlationId: 'refund-module-state', idempotencyKey: `refund:${moduleState}` },
          })
          .pipe(Effect.flip);
        const cancellation = yield* harness.runtime
          .runAction({
            payload: cancellationPayload,
            principal,
            registration: requestPaymentCancellationAction,
            transport: { correlationId: 'cancel-module-state', idempotencyKey: `cancel:${moduleState}` },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(refund, 'ModuleStateDeniedError')).toBe(true);
        expect(Predicate.isTagged(cancellation, 'ModuleStateDeniedError')).toBe(true);
        expect(harness.snapshot().committed).toHaveLength(0);
        expect(harness.snapshot().stages).not.toContain('handler_executed');
      }).pipe(Effect.provide(failClosedOwners)),
    );
  }

  it('#1150 both requests are governed write Actions with required idempotency and Legal Entity scope', () => {
    for (const registration of [requestPaymentRefundAction, requestPaymentCancellationAction]) {
      expect(registration.descriptor.entrypoint.access).toBe('write');
      expect(registration.descriptor.idempotency).toBe('required');
      expect(registration.descriptor.legalEntityScope).toBe('required');
      expect(Object.keys(registration.descriptor.domainEvents)).toEqual(['payment.core.operation-requested.v1']);
    }
  });
});

describe('#1150 typed refusals map to exact HTTP Problems', () => {
  it('#1150 refund refusals keep their code and status', () => {
    const problems = [
      paymentRefundRejected('payment_not_found', 'missing'),
      paymentRefundRejected('payment_refund_item_fractioned', 'fraction'),
      paymentRefundRejected('payment_compensation_not_established', 'unknown'),
      paymentRefundConflict('payment_refund_item_reserved', 'reserved'),
      paymentRefundConflict('payment_held_for_reconciliation', 'held'),
      paymentRefundUnavailable('payment_refund_route_unavailable', 'no route'),
      paymentRefundUnavailable('payment_owner_evidence_unavailable', 'owner down'),
    ].map(mapRequestPaymentRefundActionProblem);
    expect(problems.map((problem) => [problem.status, 'code' in problem ? problem.code : undefined])).toEqual([
      [404, 'payment_not_found'],
      [422, 'payment_refund_item_fractioned'],
      [422, 'payment_compensation_not_established'],
      [409, 'payment_refund_item_reserved'],
      [409, 'payment_held_for_reconciliation'],
      [503, 'payment_refund_route_unavailable'],
      [503, 'payment_owner_evidence_unavailable'],
    ]);
  });

  it('#1150 cancellation refusals keep their code and status', () => {
    const problems = [
      paymentCancellationRejected('payment_cancellation_after_collection', 'collected'),
      paymentCancellationRejected('payment_operation_not_found', 'missing'),
      paymentCancellationConflict('payment_cancellation_in_progress', 'live'),
      paymentCancellationUnavailable('down'),
    ].map(mapRequestPaymentCancellationActionProblem);
    expect(problems.map((problem) => [problem.status, 'code' in problem ? problem.code : undefined])).toEqual([
      [422, 'payment_cancellation_after_collection'],
      [404, 'payment_operation_not_found'],
      [409, 'payment_cancellation_in_progress'],
      [503, 'payment_unavailable'],
    ]);
  });
});
