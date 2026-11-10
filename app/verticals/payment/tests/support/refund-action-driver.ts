import { Effect, Layer, Option } from 'effect';

import type { AcceptPaymentObservationPayloadSchema } from '../../shared/actions/accept-payment-observation.ts';
import type { RecordPaymentReconciliationDecisionPayloadSchema } from '../../shared/actions/record-payment-reconciliation-decision.ts';
import type { RequestPaymentCancellationPayload } from '../../shared/actions/request-payment-cancellation.ts';
import type { RequestPaymentRefundPayload } from '../../shared/actions/request-payment-refund.ts';
import type { PaymentRefundableItem } from '../../shared/domain/payment-refund-basis.ts';
import { acceptPaymentObservationAction } from '../../src/actions/accept-payment-observation.action.ts';
import { recordPaymentReconciliationDecisionAction } from '../../src/actions/record-payment-reconciliation-decision.action.ts';
import { requestPaymentCancellationAction } from '../../src/actions/request-payment-cancellation.action.ts';
import { requestPaymentRefundAction } from '../../src/actions/request-payment-refund.action.ts';
import { CommitmentOutcomePort, unavailableCommitmentOutcome } from '../../src/ports/commitment-outcome-port.ts';
import { RefundableItemsPort, unavailableRefundableItems } from '../../src/ports/refundable-items-port.ts';
import { randomUuid } from '../integration/database-fixture.ts';
import type { PaymentTestScope } from '../integration/database-fixture.ts';
import { seedGatewayRefundRoute, seedPayment, seedRefundActor } from './refund-native-runtime.ts';
import type { RefundNativeRuntime, SeedPaymentOptions } from './refund-native-runtime.ts';
import {
  commitmentOutcomePublicContractFixture,
  refundableItemsPublicContractFixture,
} from './refund-owner-evidence.fixture.ts';
import type { CommitmentFixtureAnswer } from './refund-owner-evidence.fixture.ts';

/**
 * Drives the registered `request-payment-refund` and `request-payment-cancellation` Actions through
 * the native Core runtime for one fresh Tenant / Selling Legal Entity with one seeded Payment.
 */
export interface RefundCase {
  readonly native: RefundNativeRuntime;
  readonly payment: Effect.Success<ReturnType<typeof seedPayment>>;
  readonly principal: Effect.Success<ReturnType<typeof seedRefundActor>>;
  readonly scope: PaymentTestScope;
}

export interface RefundCaseOptions extends SeedPaymentOptions {
  /** Seed the exact original gateway account as its configured refund route (default true for gateway). */
  readonly gatewayRoute?: boolean;
}

/** One fresh Tenant / Selling Legal Entity with its acting principal and one seeded Payment. */
export const refundCaseFor = Effect.fn('RefundActionDriver.refundCaseFor')(function* refundCaseFor(
  native: RefundNativeRuntime,
  options: RefundCaseOptions,
) {
  const [legalEntityId, principalId, tenantId] = yield* Effect.all([randomUuid, randomUuid, randomUuid], {
    concurrency: 1,
  });
  const scope: PaymentTestScope = { legalEntityId, principalId, tenantId };
  const principal = yield* seedRefundActor(native, scope);
  const payment = yield* seedPayment(native.database, scope, options);
  if (options.gatewayRoute ?? options.method === undefined) {
    yield* seedGatewayRefundRoute(native.database, scope);
  }
  return { native, payment, principal, scope } satisfies RefundCase;
});

/** One complete authoritative refundable item of the future Order/Claim/Aftercare owner. */
export const refundItem = (itemRef: string, amountMinor: number): PaymentRefundableItem => ({
  amountMinor,
  currency: 'CZK',
  itemRef,
  sourceEvidenceRef: `order-line-${itemRef}`,
});

export interface RefundOwnerFixtures {
  readonly commitment?: {
    readonly answer: CommitmentFixtureAnswer;
    readonly attemptRef: string;
    readonly terminalNonCommitEvidenceRef: string;
  };
  readonly items?: readonly PaymentRefundableItem[];
}

/** Owner evidence for one case: the named public-contract fixtures, every other owner fails closed. */
export const refundOwners = (refundCase: RefundCase, fixtures: RefundOwnerFixtures) => {
  const scope = { legalEntityId: refundCase.scope.legalEntityId, tenantId: refundCase.scope.tenantId };
  const { purchaseCorrelationId } = refundCase.payment;
  const items = Option.match(Option.fromNullishOr(fixtures.items), {
    onNone: () => Layer.succeed(RefundableItemsPort, unavailableRefundableItems),
    onSome: (authoritative) =>
      refundableItemsPublicContractFixture({ items: authoritative, purchaseCorrelationId, scope }),
  });
  const commitment = Option.match(Option.fromNullishOr(fixtures.commitment), {
    onNone: () => Layer.succeed(CommitmentOutcomePort, unavailableCommitmentOutcome),
    onSome: (answer) => commitmentOutcomePublicContractFixture({ ...answer, purchaseCorrelationId, scope }),
  });
  return Layer.merge(items, commitment);
};

/** One new authorized invocation (fresh Core idempotency key unless the caller replays one). */
export const requestRefund = Effect.fn('RefundActionDriver.requestRefund')(function* requestRefund(
  refundCase: RefundCase,
  payload: RequestPaymentRefundPayload,
  fixtures: RefundOwnerFixtures,
  idempotencyKey?: string,
) {
  const key = idempotencyKey ?? (yield* randomUuid);
  return yield* refundCase.native.actionRuntime
    .runAction({
      payload,
      principal: refundCase.principal,
      registration: requestPaymentRefundAction,
      transport: { correlationId: 'payment-refund-postgres', idempotencyKey: key },
    })
    .pipe(Effect.provide(refundOwners(refundCase, fixtures)));
});

export const requestCancellation = Effect.fn('RefundActionDriver.requestCancellation')(function* requestCancellation(
  refundCase: RefundCase,
  payload: RequestPaymentCancellationPayload,
) {
  const key = yield* randomUuid;
  return yield* refundCase.native.actionRuntime.runAction({
    payload,
    principal: refundCase.principal,
    registration: requestPaymentCancellationAction,
    transport: { correlationId: 'payment-cancellation-postgres', idempotencyKey: key },
  });
});

/** An items refund request of the seeded Payment for the given complete items. */
export const itemsRefund = (
  refundCase: RefundCase,
  operationKey: string,
  items: readonly [PaymentRefundableItem, ...PaymentRefundableItem[]],
  amountMinor = items.reduce((total, item) => total + item.amountMinor, 0),
): RequestPaymentRefundPayload => ({
  amount: { amountMinor, currency: 'CZK' },
  basis: { _tag: 'REFUNDABLE_ITEMS', items },
  operationKey,
  paymentId: refundCase.payment.paymentId,
  reason: 'Customer returned the items',
});

/** A failed-commitment compensation request of the seeded Payment. */
export const compensationRefund = (
  refundCase: RefundCase,
  operationKey: string,
  amountMinor: number,
  attemptRef = 'attempt-1',
): RequestPaymentRefundPayload => ({
  amount: { amountMinor, currency: 'CZK' },
  basis: {
    _tag: 'FAILED_COMMITMENT_COMPENSATION',
    attemptRef,
    closedAgainstLateCommit: true,
    terminalNonCommitEvidenceRef: 'commitment-closure-1',
  },
  operationKey,
  paymentId: refundCase.payment.paymentId,
  reason: 'No Order was created for the collected purchase',
});

export const closedCommitment = {
  answer: 'NOT_COMMITTED_CLOSED',
  attemptRef: 'attempt-1',
  terminalNonCommitEvidenceRef: 'commitment-closure-1',
} as const;

/** A provider/source statement about this Payment through the registered acceptance Action (#1151/#1152). */
export const acceptObservation = Effect.fn('RefundActionDriver.acceptObservation')(function* acceptObservation(
  refundCase: RefundCase,
  payload: typeof AcceptPaymentObservationPayloadSchema.Encoded,
) {
  const key = yield* randomUuid;
  return yield* refundCase.native.actionRuntime.runAction({
    payload,
    principal: refundCase.principal,
    registration: acceptPaymentObservationAction,
    transport: { correlationId: 'payment-refund-observation', idempotencyKey: key },
  });
});

/** A governed reconciliation decision through the registered Action (#1151). */
export const decideReconciliation = Effect.fn('RefundActionDriver.decideReconciliation')(function* decideReconciliation(
  refundCase: RefundCase,
  payload: typeof RecordPaymentReconciliationDecisionPayloadSchema.Encoded,
) {
  const key = yield* randomUuid;
  return yield* refundCase.native.actionRuntime.runAction({
    payload,
    principal: refundCase.principal,
    registration: recordPaymentReconciliationDecisionAction,
    transport: { correlationId: 'payment-refund-reconciliation', idempotencyKey: key },
  });
});
