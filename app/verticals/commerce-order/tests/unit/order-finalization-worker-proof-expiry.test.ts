import { Effect, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it, rs } from 'effect-rstest';

import { attestOutboxWorkerHandlerContext } from '../../../../packages/core-runtime/src/outbox/definition.ts';
import { RecordOrderProofSetInputSchema } from '../../shared/domain/order-commitment.ts';
import { OrderFinalizationWorker } from '../../src/services/order-finalization-worker.service.ts';
import {
  issue788QuoteValidUntil,
  makeIssue788CommercialTotal,
  makeIssue788Quotation,
} from '../../../pricing/tests/unit/support/issue-788-confirmation.fixture.ts';
import { makeGatewayRevalidationState } from '../support/order-approval-gateway-state.ts';
import {
  lostOwnerResponse,
  makeOrderOwnerTransport,
  orderProofAnswers,
  orderWorkPath,
  ownerTransportLayer,
  recordOrderProofSetPath,
} from '../support/order-owner-transport.ts';
import {
  expiredOrderQuotation,
  orderProofPayload as payload,
  orderProofWorkerLayer,
  pricingTransportFailure,
} from '../support/order-preparation-work.ts';
import { orderTenantId } from '../support/order-revalidation-work.ts';

const revision = 'a'.repeat(64);
const originatorInvocationId = '80000000-0000-4000-8000-0000000000a2';
const afterExpiry = Date.parse(issue788QuoteValidUntil) + 2000;
const beforeExpiry = Date.parse(issue788QuoteValidUntil) - 60_000;
const context = attestOutboxWorkerHandlerContext({
  attemptNumber: 3,
  claimId: 'claim-late-proof',
  compositionRevision: revision,
  consumerModuleKey: 'commerce.order',
  correlationId: 'order-proof-late',
  deliveryId: 'delivery-late-proof',
  domainEventId: 'event-late-proof',
  legalEntityScope: 'required',
  messageId: 'message-late-proof',
  originatorInvocationId,
  producerModuleKey: 'commerce.order',
  tenantId: orderTenantId,
  tenantSequenceNo: 1n,
  topic: 'commerce.order.finalization-work',
  workerKey: 'commerce.order.finalize-order-work',
});

/**
 * The worker, its admission and its lost-response recovery run as registered over the actual Order owner
 * clients and delegated Shell client; only their HTTP peers are fakes. The Order read first answers the
 * pending proof work, then whatever it observes after a completion attempt.
 */
const deliverAt = Effect.fn('test.deliverProofAt')(function* deliverProofAt(at: number, settled: boolean) {
  yield* TestClock.setTime(at);
  // The retained Bundle holds Pricing's genuine Quotation, whose interval ends at `issue788QuoteValidUntil`.
  const answers = orderProofAnswers(
    makeGatewayRevalidationState(makeIssue788Quotation(yield* makeIssue788CommercialTotal('900'))),
  );
  const transport = makeOrderOwnerTransport({
    compositionRevision: revision,
    expiresAt: at / 1000 + 600,
    token: 'unit-token',
  });
  transport.reply(orderWorkPath, answers.pending, settled ? answers.failed : answers.pending);
  transport.reply(recordOrderProofSetPath, answers.failedProgress);
  return transport;
});
const overHttp = (transport: ReturnType<typeof makeOrderOwnerTransport>) =>
  ownerTransportLayer(async (input, init) => transport.answer(input, init));
const execute = OrderFinalizationWorker.pipe(Effect.flatMap((worker) => worker.execute(payload, context)));
const revalidateUnavailable = () => rs.fn(() => Effect.fail(pricingTransportFailure()));
const provenExpired = () => Effect.succeed(Option.some(expiredOrderQuotation));

describe('Order proof worker with an expired Quotation and no Confirmation', () => {
  it.effect('settles through a distinct terminal completion before any approval write', () =>
    Effect.gen(function* settleExpiredProof() {
      const transport = yield* deliverAt(afterExpiry, true);
      const revalidate = revalidateUnavailable();
      yield* execute.pipe(
        Effect.provide(orderProofWorkerLayer(provenExpired, revalidate)),
        Effect.provide(overHttp(transport)),
      );
      expect(revalidate).not.toHaveBeenCalled();
      const [completion, ...others] = transport.sentTo(recordOrderProofSetPath);
      expect(others).toHaveLength(0);
      expect(completion === undefined ? undefined : new URL(completion.url).origin).toBe('https://order.unit.invalid');
      expect(completion?.headers.get('authorization')).toBe('Bearer unit-token');
      expect(completion?.headers.get('x-correlation-id')).toBe(context.correlationId);
      expect(completion?.headers.get('x-ontos-composition-revision')).toBe(revision);
      expect(completion?.headers.get('idempotency-key')).toBe(
        `order-complete:${payload.intentRef.resourceId}:quotation-expired:${originatorInvocationId}`,
      );
      expect(yield* transport.bodies(recordOrderProofSetPath, RecordOrderProofSetInputSchema)).toEqual([
        {
          intentRef: payload.intentRef,
          originatorActionInvocationId: originatorInvocationId,
          outcome: 'PRICING_QUOTATION_EXPIRED',
        },
      ]);
    }),
  );
  it.effect('treats a lost completion response as settled only after observing the FAILED intent', () =>
    Effect.gen(function* recoverLostProofResponse() {
      const transport = yield* deliverAt(afterExpiry, true);
      transport.reply(recordOrderProofSetPath, lostOwnerResponse);
      yield* execute.pipe(
        Effect.provide(orderProofWorkerLayer(provenExpired, revalidateUnavailable())),
        Effect.provide(overHttp(transport)),
      );
      expect(transport.sentTo(recordOrderProofSetPath)).toHaveLength(1);
      expect(transport.sentTo(orderWorkPath)).toHaveLength(2);
    }),
  );
  it.effect('keeps the delivery retryable when Pricing cannot be read', () =>
    Effect.gen(function* transportFailure() {
      const transport = yield* deliverAt(afterExpiry, false);
      const revalidate = revalidateUnavailable();
      const failure = yield* execute.pipe(
        Effect.provide(orderProofWorkerLayer(() => Effect.fail(pricingTransportFailure()), revalidate)),
        Effect.provide(overHttp(transport)),
        Effect.flip,
      );
      expect(failure.code).toBe('order_commitment_unavailable');
      expect(transport.sentTo(recordOrderProofSetPath)).toHaveLength(0);
      expect(revalidate).not.toHaveBeenCalled();
    }),
  );
  it.effect('continues the original proof path when Pricing does not prove expiry', () =>
    Effect.gen(function* notProvenExpired() {
      const transport = yield* deliverAt(afterExpiry, false);
      const revalidate = revalidateUnavailable();
      const failure = yield* execute.pipe(
        Effect.provide(orderProofWorkerLayer(() => Effect.succeed(Option.none()), revalidate)),
        Effect.provide(overHttp(transport)),
        Effect.flip,
      );
      expect(failure.code).toBe('order_commitment_unavailable');
      expect(revalidate).toHaveBeenCalledOnce();
      expect(transport.sentTo(recordOrderProofSetPath)).toHaveLength(0);
    }),
  );
  it.effect('does not ask Pricing about expiry before the retained interval has ended', () =>
    Effect.gen(function* beforeRetainedEnd() {
      const transport = yield* deliverAt(beforeExpiry, false);
      const read = rs.fn(provenExpired);
      const revalidate = revalidateUnavailable();
      yield* execute.pipe(
        Effect.provide(orderProofWorkerLayer(read, revalidate)),
        Effect.provide(overHttp(transport)),
        Effect.flip,
      );
      expect(read).not.toHaveBeenCalled();
      expect(revalidate).toHaveBeenCalledOnce();
      expect(transport.sentTo(recordOrderProofSetPath)).toHaveLength(0);
    }),
  );
});
