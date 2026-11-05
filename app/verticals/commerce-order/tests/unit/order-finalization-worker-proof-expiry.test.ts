import { Effect, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { afterAll, describe, expect, it, rs } from 'effect-rstest';

import { attestOutboxWorkerHandlerContext } from '../../../../packages/core-runtime/src/outbox/definition.ts';
import { executeRecordOrderProofSetWithAuthorization } from '../../src/api/record-order-proof-set-action-client.ts';
import { OrderFinalizationWorker } from '../../src/services/order-finalization-worker.service.ts';
import {
  expiredOrderQuotation,
  failedOrderProofWork,
  orderProofPayload as payload,
  orderProofWorkerLayer,
  pendingOrderProofWork,
  pricingTransportFailure,
} from '../support/order-preparation-work.ts';
import { orderTenantId } from '../support/order-revalidation-work.ts';

const owners = rs.hoisted(() => ({
  complete: rs.fn<() => Effect.Effect<unknown, unknown>>(),
  issueGateway: rs.fn<() => Effect.Effect<unknown>>(),
  load: rs.fn<() => Effect.Effect<unknown>>(),
  revalidate: rs.fn<() => Effect.Effect<never, ReturnType<typeof pricingTransportFailure>>>(),
}));

// Only the Order owner transport and the Shell assertion issuer are replaced; the worker,
// its admission and its lost-response recovery run as registered.
rs.mock('@app/shared-contracts/gateway-context-server', () => ({
  acquireDelegatedGatewayContext: owners.issueGateway,
}));
rs.mock('../../src/api/order-finalization-work-client.ts', () => ({
  executeOrderFinalizationWorkWithAuthorization: owners.load,
}));
rs.mock('../../src/api/record-order-proof-set-action-client.ts', () => ({
  executeRecordOrderProofSetWithAuthorization: owners.complete,
}));

const revision = 'a'.repeat(64);
const afterExpiry = Date.parse('2026-10-29T12:00:02.000Z');
const beforeExpiry = Date.parse('2026-10-29T11:59:00.000Z');
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
  originatorInvocationId: '80000000-0000-4000-8000-0000000000a2',
  producerModuleKey: 'commerce.order',
  tenantId: orderTenantId,
  tenantSequenceNo: 1n,
  topic: 'commerce.order.finalization-work',
  workerKey: 'commerce.order.finalize-order-work',
});
type Observation = typeof failedOrderProofWork | typeof pendingOrderProofWork;
const reset = (observedAfterCompletion: Observation, at = afterExpiry) =>
  Effect.gen(function* resetOwners() {
    yield* TestClock.setTime(at);
    owners.issueGateway.mockReset();
    owners.issueGateway.mockReturnValue(
      Effect.succeed({
        apiBaseUrl: '/order-api',
        authorization: 'Bearer unit-token',
        compositionRevision: revision,
        expiresAt: at / 1000 + 600,
      }),
    );
    owners.load.mockReset();
    owners.load.mockReturnValueOnce(Effect.succeed(pendingOrderProofWork));
    owners.load.mockReturnValue(Effect.succeed(observedAfterCompletion));
    owners.complete.mockReset();
    owners.revalidate.mockReset();
    owners.revalidate.mockReturnValue(Effect.fail(pricingTransportFailure()));
  });
const execute = OrderFinalizationWorker.pipe(Effect.flatMap((worker) => worker.execute(payload, context)));
const withExpiry = (read: () => Effect.Effect<Option.Option<typeof expiredOrderQuotation>>) =>
  orderProofWorkerLayer(read, owners.revalidate);
const provenExpired = withExpiry(() => Effect.succeed(Option.some(expiredOrderQuotation)));

describe('Order proof worker with an expired Quotation and no Confirmation', () => {
  it.effect('settles through a distinct terminal completion before any approval write', () =>
    Effect.gen(function* settleExpiredProof() {
      yield* reset(failedOrderProofWork);
      owners.complete.mockReturnValue(Effect.succeed({ status: 'FAILED' }));
      yield* execute.pipe(Effect.provide(provenExpired));
      expect(owners.revalidate).not.toHaveBeenCalled();
      expect(executeRecordOrderProofSetWithAuthorization).toHaveBeenCalledExactlyOnceWith(
        {
          intentRef: payload.intentRef,
          originatorActionInvocationId: '80000000-0000-4000-8000-0000000000a2',
          outcome: 'PRICING_QUOTATION_EXPIRED',
        },
        'Bearer unit-token',
        context.correlationId,
        {
          authorization: 'Bearer unit-token',
          baseUrl: new URL('https://order.unit.invalid'),
          compositionRevision: revision,
          idempotencyKey: `order-complete:${payload.intentRef.resourceId}:quotation-expired:80000000-0000-4000-8000-0000000000a2`,
        },
      );
    }),
  );
  it.effect('treats a lost completion response as settled only after observing the FAILED intent', () =>
    Effect.gen(function* recoverLostProofResponse() {
      yield* reset(failedOrderProofWork);
      owners.complete.mockReturnValue(Effect.fail(pricingTransportFailure()));
      yield* execute.pipe(Effect.provide(provenExpired));
      expect(owners.complete).toHaveBeenCalledOnce();
      expect(owners.load).toHaveBeenCalledTimes(2);
    }),
  );
  it.effect('keeps the delivery retryable when Pricing cannot be read', () =>
    Effect.gen(function* transportFailure() {
      yield* reset(pendingOrderProofWork);
      const failure = yield* execute.pipe(
        Effect.provide(orderProofWorkerLayer(() => Effect.fail(pricingTransportFailure()), owners.revalidate)),
        Effect.flip,
      );
      expect(failure.code).toBe('order_commitment_unavailable');
      expect(owners.complete).not.toHaveBeenCalled();
      expect(owners.revalidate).not.toHaveBeenCalled();
    }),
  );
  it.effect('continues the original proof path when Pricing does not prove expiry', () =>
    Effect.gen(function* notProvenExpired() {
      yield* reset(pendingOrderProofWork);
      const failure = yield* execute.pipe(Effect.provide(withExpiry(() => Effect.succeed(Option.none()))), Effect.flip);
      expect(failure.code).toBe('order_commitment_unavailable');
      expect(owners.revalidate).toHaveBeenCalledOnce();
      expect(owners.complete).not.toHaveBeenCalled();
    }),
  );
  it.effect('does not ask Pricing about expiry before the retained interval has ended', () =>
    Effect.gen(function* beforeRetainedEnd() {
      yield* reset(pendingOrderProofWork, beforeExpiry);
      const read = rs.fn(() => Effect.succeed(Option.some(expiredOrderQuotation)));
      yield* execute.pipe(Effect.provide(withExpiry(read)), Effect.flip);
      expect(read).not.toHaveBeenCalled();
      expect(owners.revalidate).toHaveBeenCalledOnce();
      expect(owners.complete).not.toHaveBeenCalled();
    }),
  );
});

// With `isolate: false` one module registry is shared by every file a worker runs, so these
// replacements outlive this file and would leak into whatever runs next. Remove them and drop the
// modules they replaced, so the next file evaluates the real implementations.
afterAll(() => {
  rs.doUnmock('@app/shared-contracts/gateway-context-server');
  rs.doUnmock('../../src/api/order-finalization-work-client.ts');
  rs.doUnmock('../../src/api/record-order-proof-set-action-client.ts');
  rs.resetModules();
});
