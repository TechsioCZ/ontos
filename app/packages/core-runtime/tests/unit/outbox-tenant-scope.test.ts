import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { ScopedRoutineInvoker } from '../../src/db/scoped-routine.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import { makeOutboxWorkerTenantScope, OutboxWorkerTenantScopeError } from '../../src/outbox/tenant-scope.ts';
import type { OutboxWorkerTenantScopeBackend } from '../../src/outbox/tenant-scope.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const context = {
  attemptNumber: 1,
  claimId: 'claim-1',
  consumerModuleKey: 'pricing.price-group-catalog',
  deliveryId: 'delivery-1',
  domainEventId: 'event-1',
  legalEntityScope: 'forbidden' as const,
  messageId: 'message-1',
  producerModuleKey: 'pricing.price-group-catalog',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'pricing.price-group-catalog.projection-requested.v1',
  workerKey: 'pricing.price-group-catalog.project-containment',
};

const unavailableInvoker: ScopedRoutineInvoker = {
  invoke: () => Effect.die('not used'),
};

it.effect('runs exactly once in the attested tenant-only scope', () =>
  Effect.gen(function* runTenantScope() {
    let calls = 0;
    const backend: OutboxWorkerTenantScopeBackend = {
      run: (workerContext, observe) => {
        calls += 1;
        return observe({
          completionPublisher: { publish: () => Effect.die('not used') },
          routineInvoker: unavailableInvoker,
          tenantId: workerContext.tenantId,
        });
      },
    };
    const service = makeOutboxWorkerTenantScope(backend);
    yield* service.run(attestOutboxWorkerHandlerContext(context), (scope) =>
      Effect.sync(() => {
        expect(scope.tenantId).toBe(tenantId);
        expect(Object.keys(scope).toSorted()).toEqual(['completionPublisher', 'routineInvoker', 'tenantId']);
      }),
    );
    expect(calls).toBe(1);
  }),
);

it.effect('rejects unverified or Legal-Entity-scoped worker contexts before opening a transaction', () =>
  Effect.gen(function* rejectInvalidContexts() {
    let calls = 0;
    const service = makeOutboxWorkerTenantScope({
      run: () => {
        calls += 1;
        return Effect.void;
      },
    });
    const failures = [
      yield* Effect.flip(service.run(context, () => Effect.void)),
      yield* Effect.flip(
        service.run(attestOutboxWorkerHandlerContext({ ...context, legalEntityScope: 'required' }), () => Effect.void),
      ),
      yield* Effect.flip(
        service.run(attestOutboxWorkerHandlerContext({ ...context, tenantId: 'other-tenant' }), () => Effect.void),
      ),
    ];
    expect(failures.every((failure) => Schema.is(OutboxWorkerTenantScopeError)(failure))).toBe(true);
    expect(failures.every((failure) => !failure.retryable)).toBe(true);
    expect(calls).toBe(0);
  }),
);
