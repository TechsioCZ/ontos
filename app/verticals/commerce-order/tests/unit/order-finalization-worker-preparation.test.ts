import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { attestOutboxWorkerHandlerContext } from '../../../../packages/core-runtime/src/outbox/definition.ts';
import { CompleteOrderPreparationInputSchema } from '../../shared/domain/order-commitment.ts';
import { OrderFinalizationWorker } from '../../src/services/order-finalization-worker.service.ts';
import {
  completeOrderPreparationPath,
  failedOrderPreparationAnswer,
  failedPreparationProgressAnswer,
  lostOwnerResponse,
  makeOrderOwnerTransport,
  orderWorkPath,
  ownerTransportLayer,
  pendingOrderPreparationAnswer,
} from '../support/order-owner-transport.ts';
import type { OwnerReply } from '../support/order-owner-transport.ts';
import {
  expiredOrderQuotation,
  orderPreparationPayload as payload,
  orderPreparationWorkerLayer,
  pricingTransportFailure,
} from '../support/order-preparation-work.ts';
import { orderTenantId } from '../support/order-revalidation-work.ts';

const revision = 'a'.repeat(64);
const originatorInvocationId = '80000000-0000-4000-8000-0000000000a1';
const deliveredContext = {
  attemptNumber: 2,
  claimId: 'claim-delayed',
  compositionRevision: revision,
  consumerModuleKey: 'commerce.order',
  correlationId: 'order-preparation-delayed',
  deliveryId: 'delivery-delayed',
  domainEventId: 'event-delayed',
  legalEntityScope: 'required',
  messageId: 'message-delayed',
  producerModuleKey: 'commerce.order',
  tenantId: orderTenantId,
  tenantSequenceNo: 1n,
  topic: 'commerce.order.finalization-work',
  workerKey: 'commerce.order.finalize-order-work',
} as const;
const context = attestOutboxWorkerHandlerContext({ ...deliveredContext, originatorInvocationId });

// The worker, its admission and its lost-response recovery run as registered over the actual Order
// owner clients and delegated Shell client; only their HTTP peers are fakes.
const transportFor = (...observations: readonly OwnerReply[]) => {
  const transport = makeOrderOwnerTransport({ compositionRevision: revision, expiresAt: 3600, token: 'unit-token' });
  transport.reply(orderWorkPath, ...observations);
  transport.reply(completeOrderPreparationPath, failedPreparationProgressAnswer);
  return transport;
};
const overHttp = (transport: ReturnType<typeof makeOrderOwnerTransport>) =>
  ownerTransportLayer(async (input, init) => transport.answer(input, init));
const expectCompletion = (request: Request | undefined, correlationId: string, invocationId: string) => {
  expect(request === undefined ? undefined : new URL(request.url).origin).toBe('https://order.unit.invalid');
  expect(request?.headers.get('authorization')).toBe('Bearer unit-token');
  expect(request?.headers.get('x-correlation-id')).toBe(correlationId);
  expect(request?.headers.get('x-ontos-composition-revision')).toBe(revision);
  expect(request?.headers.get('idempotency-key')).toBe(
    `order-complete:${payload.intentRef.resourceId}:prepare:${invocationId}`,
  );
};
const execute = OrderFinalizationWorker.pipe(Effect.flatMap((worker) => worker.execute(payload, context)));
const expired = orderPreparationWorkerLayer(() => Effect.succeed(expiredOrderQuotation));

describe('Order preparation worker with an expired Quotation', () => {
  it.effect('acknowledges owner-proven expiry through the original completion instead of leaving work pending', () =>
    Effect.gen(function* settleExpiredPreparation() {
      const transport = transportFor(pendingOrderPreparationAnswer, failedOrderPreparationAnswer);
      yield* execute.pipe(Effect.provide(expired), Effect.provide(overHttp(transport)));
      expect(transport.sentTo(completeOrderPreparationPath)).toHaveLength(1);
      expectCompletion(
        transport.sentTo(completeOrderPreparationPath)[0],
        deliveredContext.correlationId,
        originatorInvocationId,
      );
      expect(yield* transport.bodies(completeOrderPreparationPath, CompleteOrderPreparationInputSchema)).toEqual([
        { intentRef: payload.intentRef, originatorActionInvocationId: originatorInvocationId },
      ]);
    }),
  );
  it.effect('keys each completion by the invocation it acts for, so two originators never share a key', () =>
    Effect.gen(function* distinctOriginatorKeys() {
      const transport = transportFor(
        pendingOrderPreparationAnswer,
        pendingOrderPreparationAnswer,
        failedOrderPreparationAnswer,
      );
      yield* execute.pipe(Effect.provide(expired), Effect.provide(overHttp(transport)));
      const otherInvocationId = '80000000-0000-4000-8000-0000000000a3';
      const other = attestOutboxWorkerHandlerContext({
        ...deliveredContext,
        originatorInvocationId: otherInvocationId,
      });
      yield* OrderFinalizationWorker.pipe(
        Effect.flatMap((worker) => worker.execute(payload, other)),
        Effect.provide(expired),
        Effect.provide(overHttp(transport)),
      );
      const completions = transport.sentTo(completeOrderPreparationPath);
      expect(completions).toHaveLength(2);
      expectCompletion(completions[1], deliveredContext.correlationId, otherInvocationId);
      expect((yield* transport.bodies(completeOrderPreparationPath, CompleteOrderPreparationInputSchema))[1]).toEqual({
        intentRef: payload.intentRef,
        originatorActionInvocationId: otherInvocationId,
      });
    }),
  );
  it.effect('requests the Shell delegation as the delivering invocation, never as the worker', () =>
    Effect.gen(function* delegateAsOriginator() {
      const transport = transportFor(pendingOrderPreparationAnswer, failedOrderPreparationAnswer);
      yield* execute.pipe(Effect.provide(expired), Effect.provide(overHttp(transport)));
      const delegations = yield* transport.delegations();
      expect(delegations.length).toBeGreaterThan(0);
      for (const delegation of delegations) {
        expect(delegation).toMatchObject({
          audience: 'commerce-order',
          compositionRevision: revision,
          subject: { _tag: 'Originator', actionInvocationId: originatorInvocationId, tenantId: orderTenantId },
        });
      }
    }),
  );
  it.effect('fails permanently, with no owner read, delegation or completion, when no originator was delivered', () =>
    Effect.gen(function* refuseUnoriginatedWork() {
      const transport = transportFor(pendingOrderPreparationAnswer);
      const unoriginated = attestOutboxWorkerHandlerContext({ ...deliveredContext });
      const failure = yield* OrderFinalizationWorker.pipe(
        Effect.flatMap((worker) => worker.execute(payload, unoriginated)),
        Effect.provide(expired),
        Effect.provide(overHttp(transport)),
        Effect.flip,
      );
      expect(failure.code).toBe('order_commitment_conflict');
      expect(transport.requests()).toHaveLength(0);
    }),
  );
  it.effect('treats a lost completion response as settled only after observing the FAILED intent', () =>
    Effect.gen(function* recoverLostTerminalResponse() {
      const transport = transportFor(pendingOrderPreparationAnswer, failedOrderPreparationAnswer);
      transport.reply(completeOrderPreparationPath, lostOwnerResponse);
      yield* execute.pipe(Effect.provide(expired), Effect.provide(overHttp(transport)));
      expect(transport.sentTo(completeOrderPreparationPath)).toHaveLength(1);
      expect(transport.sentTo(orderWorkPath)).toHaveLength(2);
    }),
  );
  it.effect('keeps the delivery retryable when the completion outcome stays unobserved', () =>
    Effect.gen(function* unresolvedCompletion() {
      const transport = transportFor(pendingOrderPreparationAnswer);
      transport.reply(completeOrderPreparationPath, lostOwnerResponse);
      const failure = yield* execute.pipe(Effect.provide(expired), Effect.provide(overHttp(transport)), Effect.flip);
      expect(failure.code).toBe('order_commitment_unavailable');
    }),
  );
  it.effect('never completes preparation when Pricing transport fails and leaves the work pending', () =>
    Effect.gen(function* transportFailure() {
      const transport = transportFor(pendingOrderPreparationAnswer);
      const failure = yield* execute.pipe(
        Effect.provide(orderPreparationWorkerLayer(() => Effect.fail(pricingTransportFailure()))),
        Effect.provide(overHttp(transport)),
        Effect.flip,
      );
      expect(failure.code).toBe('order_commitment_unavailable');
      expect(transport.sentTo(completeOrderPreparationPath)).toHaveLength(0);
    }),
  );
});
