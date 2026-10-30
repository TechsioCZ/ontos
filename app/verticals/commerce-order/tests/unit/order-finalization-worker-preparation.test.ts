import { Effect } from 'effect';
import { describe, expect, it, rs } from 'effect-rstest';

import { attestOutboxWorkerHandlerContext } from '../../../../packages/core-runtime/src/outbox/definition.ts';
import { executeCompleteOrderPreparationWithAuthorization } from '../../src/api/complete-order-preparation-action-client.ts';
import { OrderFinalizationWorker } from '../../src/services/order-finalization-worker.service.ts';
import {
  expiredOrderQuotation,
  failedOrderPreparationWork,
  orderPreparationPayload as payload,
  orderPreparationWorkerLayer,
  pendingOrderPreparationWork,
  pricingTransportFailure,
} from '../support/order-preparation-work.ts';
import type { OrderPreparationWorkObservation } from '../support/order-preparation-work.ts';
import { orderTenantId } from '../support/order-revalidation-work.ts';

const owners = rs.hoisted(() => ({
  complete: rs.fn<() => Effect.Effect<unknown, unknown>>(),
  issueGateway: rs.fn<() => Effect.Effect<unknown>>(),
  load: rs.fn<() => Effect.Effect<unknown>>(),
}));

// Only the Order owner transport and the Shell assertion issuer are replaced; the worker,
// its admission and its lost-response recovery run as registered.
rs.mock('@app/shared-contracts/server/gateway-context-api-key', () => ({
  issueApiKeyGatewayContext: owners.issueGateway,
}));
rs.mock('../../src/api/order-finalization-work-client.ts', () => ({
  executeOrderFinalizationWorkWithAuthorization: owners.load,
}));
rs.mock('../../src/api/complete-order-preparation-action-client.ts', () => ({
  executeCompleteOrderPreparationWithAuthorization: owners.complete,
}));

const revision = 'a'.repeat(64);
const context = attestOutboxWorkerHandlerContext({
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
});
const reset = (observedAfterCompletion: OrderPreparationWorkObservation) => {
  owners.issueGateway.mockReset();
  owners.issueGateway.mockReturnValue(
    Effect.succeed({ apiBaseUrl: '/order-api', compositionRevision: revision, expiresAt: 3600, token: 'unit-token' }),
  );
  owners.load.mockReset();
  owners.load.mockReturnValueOnce(Effect.succeed(pendingOrderPreparationWork));
  owners.load.mockReturnValue(Effect.succeed(observedAfterCompletion));
  owners.complete.mockReset();
};
const execute = OrderFinalizationWorker.pipe(Effect.flatMap((worker) => worker.execute(payload, context)));
const expired = orderPreparationWorkerLayer(() => Effect.succeed(expiredOrderQuotation));

describe('Order preparation worker with an expired Quotation', () => {
  it.effect('acknowledges owner-proven expiry through the original completion instead of leaving work pending', () =>
    Effect.gen(function* settleExpiredPreparation() {
      reset(failedOrderPreparationWork);
      owners.complete.mockReturnValue(
        Effect.succeed({ binding: null, intentRef: payload.intentRef, status: 'FAILED' }),
      );
      yield* execute.pipe(Effect.provide(expired));
      expect(executeCompleteOrderPreparationWithAuthorization).toHaveBeenCalledExactlyOnceWith(
        { intentRef: payload.intentRef },
        'Bearer unit-token',
        context.correlationId,
        {
          authorization: 'Bearer unit-token',
          baseUrl: new URL('https://order.unit.invalid'),
          compositionRevision: revision,
          idempotencyKey: `order-complete:${payload.intentRef.resourceId}:prepare`,
        },
      );
    }),
  );
  it.effect('treats a lost completion response as settled only after observing the FAILED intent', () =>
    Effect.gen(function* recoverLostTerminalResponse() {
      reset(failedOrderPreparationWork);
      owners.complete.mockReturnValue(Effect.fail(pricingTransportFailure()));
      yield* execute.pipe(Effect.provide(expired));
      expect(owners.complete).toHaveBeenCalledOnce();
      expect(owners.load).toHaveBeenCalledTimes(2);
    }),
  );
  it.effect('keeps the delivery retryable when the completion outcome stays unobserved', () =>
    Effect.gen(function* unresolvedCompletion() {
      reset(pendingOrderPreparationWork);
      owners.complete.mockReturnValue(Effect.fail(pricingTransportFailure()));
      const failure = yield* execute.pipe(Effect.provide(expired), Effect.flip);
      expect(failure.code).toBe('order_commitment_unavailable');
    }),
  );
  it.effect('never completes preparation when Pricing transport fails and leaves the work pending', () =>
    Effect.gen(function* transportFailure() {
      reset(pendingOrderPreparationWork);
      const failure = yield* execute.pipe(
        Effect.provide(orderPreparationWorkerLayer(() => Effect.fail(pricingTransportFailure()))),
        Effect.flip,
      );
      expect(failure.code).toBe('order_commitment_unavailable');
      expect(owners.complete).not.toHaveBeenCalled();
    }),
  );
});
