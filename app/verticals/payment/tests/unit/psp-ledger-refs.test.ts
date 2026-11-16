import type { OutboxWorkerHandlerContext } from '@app/core-runtime/outbox/worker';
import { Effect, Exit, Option, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { providerRefOfText, providerRefText, workerOriginOf } from '../../src/integrations/psp/dispatch-ledger-live.ts';
import { ProviderObjectRefSchema } from '../../src/integrations/psp/psp-request.ts';

const delivery: OutboxWorkerHandlerContext = {
  attemptNumber: 1,
  claimId: 'claim-1',
  compositionRevision: 'c'.repeat(64),
  deliveryId: '0f8b5c1e-3a2d-4c7b-9e1f-5a6b7c8d9e0f',
  domainEventId: 'event-1',
  messageId: 'message-1',
  producerModuleKey: 'payment.core',
  tenantId: '7d3e9a10-55b2-4f6c-8a1d-2b3c4d5e6f70',
  tenantSequenceNo: 1n,
  topic: 'payment.core.operation-requested.v1',
  workerKey: 'payment.core.execute-gateway-operation',
};

describe('#1158 Provider dispatch ledger references and origin', () => {
  it('#1158 Every provider object reference round-trips through its persisted text exactly', () => {
    const refs = Schema.decodeUnknownSync(Schema.Array(ProviderObjectRefSchema))([
      { _tag: 'GOPAY_PAYMENT', id: '3000006529' },
      { _tag: 'STRIPE_CHECKOUT_SESSION', id: 'cs_test_a1:b2' },
      { _tag: 'STRIPE_PAYMENT_INTENT', id: 'pi_test_1' },
      { _tag: 'STRIPE_REFUND', id: 're_test_1' },
      { _tag: 'COMGATE_TRANSACTION', transId: 'AB12-CD34-EF56' },
    ]);
    for (const ref of refs) {
      expect(providerRefOfText(providerRefText(ref))).toEqual(Option.some(ref));
    }
    // The object kind is part of the stored reference, so the same id of another kind never matches.
    expect(providerRefText(refs[2] ?? refs[0])).not.toBe(`STRIPE_REFUND:pi_test_1`);
  });

  it('#1158 Text the ledger did not write is never read as a provider object', () => {
    for (const text of ['3000006529', ':pi_test_1', 'UNKNOWN_KIND:pi_test_1', 'GOPAY_PAYMENT:', 'GOPAY_PAYMENT:a b']) {
      expect(Option.isNone(providerRefOfText(text))).toBe(true);
    }
  });

  it.effect('#1158 A delivery without an originating Action invocation writes nothing', () =>
    Effect.gen(function* missingOrigin() {
      const refused = yield* Effect.exit(workerOriginOf(delivery));
      expect(Exit.isFailure(refused)).toBe(true);
      const failure = yield* Effect.flip(workerOriginOf(delivery));
      expect(Predicate.isTagged(failure, 'GatewayLedgerUnavailable')).toBe(true);

      const origin = yield* workerOriginOf({
        ...delivery,
        originatorInvocationId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      });
      expect(origin).toEqual({
        compositionRevision: delivery.compositionRevision,
        deliveryId: delivery.deliveryId,
        originActionInvocationId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
        workerKey: delivery.workerKey,
      });
    }),
  );
});
