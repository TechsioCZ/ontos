import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { financeBillingRegistration } from '../../vertical.registration.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const request = {
  payload: {},
  principal: {
    authBindingId: '60000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:search-rebuild',
    authMethod: 'session' as const,
    principalId: '50000000-0000-4000-8000-000000000001',
    tenantId,
  },
  registration: requestSearchRebuildAction,
  transport: { correlationId: 'search-rebuild', idempotencyKey: 'rebuild-1' },
};
it.effect('explicit operator Action queues one event/outbox pair and replay cannot duplicate it', () =>
  Effect.gen(function* test() {
    const harness = yield* makeActionTestHarness({
      access: { 'finance.billing.request-search-rebuild.write': 'allowed' },
      ownerRegistration: financeBillingRegistration,
    });
    const result = yield* harness.runtime.runAction(request);
    expect(result.status).toBe('QUEUED');
    expect(requestSearchRebuildAction.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
    const { committed } = harness.snapshot();
    expect(committed).toHaveLength(1);
    expect(committed[0]?.evidence.domainEvents).toHaveLength(1);
    expect(committed[0]?.evidence.outboxMessages).toMatchObject([
      {
        domainEventIndex: 0,
        message: { producerModuleKey: 'finance.billing', topic: 'finance.billing.search-rebuild-requested.v1' },
      },
    ]);
    expect(
      Predicate.isTagged(yield* harness.runtime.runAction(request).pipe(Effect.flip), 'ActionAlreadyCommitted'),
    ).toBe(true);
    expect(harness.snapshot().committed).toHaveLength(1);
  }),
);
for (const access of ['denied', 'unavailable'] as const) {
  it.effect(`${access} operator capability fails closed without queueing work`, () =>
    Effect.gen(function* test() {
      const harness = yield* makeActionTestHarness({
        access: { 'finance.billing.request-search-rebuild.write': access },
        ownerRegistration: financeBillingRegistration,
      });
      expect(
        Predicate.isTagged(
          yield* harness.runtime.runAction(request).pipe(Effect.flip),
          access === 'denied' ? 'ActionPermissionDenied' : 'ActionPermissionCheckError',
        ),
      ).toBe(true);
      expect(harness.snapshot().transactionCount).toBe(0);
      expect(harness.snapshot().committed).toEqual([]);
    }),
  );
}
