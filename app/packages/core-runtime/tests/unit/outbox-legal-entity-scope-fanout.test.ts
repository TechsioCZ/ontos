import { expect, it } from 'effect-rstest';
import { Effect, Predicate, Schema } from 'effect';
import type { ScopedRoutineInvoker } from '../../src/db/scoped-routine.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import {
  makeOutboxWorkerLegalEntityScopeFanout,
  OutboxWorkerLegalEntityScopeError,
} from '../../src/outbox/legal-entity-scope-fanout.ts';
import type {
  OutboxWorkerLegalEntityScopeBackend,
  OutboxWorkerLegalEntityScopeRecord,
} from '../../src/outbox/legal-entity-scope-fanout.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '20000000-0000-4000-8000-000000000002';
const legalEntityOne = '30000000-0000-4000-8000-000000000003';
const legalEntityTwo = '30000000-0000-4000-8000-000000000002';

const context = {
  attemptNumber: 1,
  claimId: 'claim-1',
  deliveryId: 'delivery-1',
  domainEventId: 'event-1',
  messageId: 'message-1',
  producerModuleKey: 'party.registry',
  tenantId,
  tenantSequenceNo: 10n,
  topic: 'party.registry.party-merged.v1',
  workerKey: 'commerce.customer-context.reconcile-party-merge',
} as const;

const unavailableInvoker: ScopedRoutineInvoker = {
  invoke: () => Effect.die(new Error('The unit backend does not execute owner routines')),
};
const unavailableCompletionPublisher = {
  publish: () => Effect.die(new Error('The unit backend does not publish worker completions')),
} as const;

const active = (
  legalEntityId: string,
  recordTenantId = tenantId,
): OutboxWorkerLegalEntityScopeRecord => ({
  legalEntityId,
  status: 'active',
  tenantId: recordTenantId,
});

const backend = (
  records: readonly OutboxWorkerLegalEntityScopeRecord[],
  calls: string[],
): OutboxWorkerLegalEntityScopeBackend => ({
  list: () => Effect.succeed(records),
  run: (workerContext, legalEntityId, observe) => {
    calls.push(legalEntityId);
    return observe({
      completionPublisher: unavailableCompletionPublisher,
      legalEntityId,
      routineInvoker: unavailableInvoker,
      tenantId: workerContext.tenantId,
    });
  },
});

it.effect('rejects caller-created worker evidence before legal-entity enumeration', () => {
  let listed = 0;
  const fanout = makeOutboxWorkerLegalEntityScopeFanout({
    list: () => {
      listed += 1;
      return Effect.succeed([active(legalEntityOne)]);
    },
    run: () => Effect.void,
  });
  return Effect.gen(function* rejectUnverifiedContext() {
    const failure = yield* Effect.flip(fanout.forEachScope(context, () => Effect.void));
    expect(failure.code).toBe('outbox_worker_scope_context_invalid');
    expect(failure.retryable).toBe(false);
    expect(listed).toBe(0);
  });
});

it.effect('enumerates every Tenant-owned lifecycle scope once in deterministic order', () => {
  const calls: string[] = [];
  const fanout = makeOutboxWorkerLegalEntityScopeFanout(
    backend(
      [
        active(legalEntityOne),
        { ...active('30000000-0000-4000-8000-000000000004'), status: 'suspended' },
        { ...active('30000000-0000-4000-8000-000000000005'), status: 'archived' },
        active(legalEntityTwo),
      ],
      calls,
    ),
  );
  return Effect.gen(function* enumerateExactScopes() {
    const callbackScopes: string[] = [];
    yield* fanout.forEachScope(attestOutboxWorkerHandlerContext(context), (scope) => {
      expect(scope.tenantId).toBe(tenantId);
      expect(Object.keys(scope).toSorted()).toEqual([
        'completionPublisher',
        'legalEntityId',
        'routineInvoker',
        'tenantId',
      ]);
      callbackScopes.push(scope.legalEntityId);
      return Effect.void;
    });
    expect(calls).toEqual([
      legalEntityTwo,
      legalEntityOne,
      '30000000-0000-4000-8000-000000000004',
      '30000000-0000-4000-8000-000000000005',
    ]);
    expect(callbackScopes).toEqual([
      legalEntityTwo,
      legalEntityOne,
      '30000000-0000-4000-8000-000000000004',
      '30000000-0000-4000-8000-000000000005',
    ]);
  });
});

it.effect('fails closed for empty, duplicate, and cross-Tenant enumerations', () => {
  const verified = attestOutboxWorkerHandlerContext(context);
  return Effect.gen(function* rejectIndeterminateScopes() {
    const records = [
      [],
      [active(legalEntityOne), active(legalEntityOne)],
      [active(legalEntityOne, otherTenantId)],
      [{ ...active(legalEntityOne), status: 'unknown' }],
    ] as const;
    for (const candidate of records) {
      const calls: string[] = [];
      const failure = yield* Effect.flip(
        makeOutboxWorkerLegalEntityScopeFanout(backend(candidate, calls)).forEachScope(
          verified,
          () => Effect.void,
        ),
      );
      expect(Predicate.isTagged(failure, 'OutboxWorkerLegalEntityScopeError')).toBe(true);
      expect(calls).toEqual([]);
    }
  });
});

it.effect('preserves an owner failure and does not invoke later legal-entity scopes', () => {
  const calls: string[] = [];
  const OwnerFailure = Schema.TaggedError<Error>()('OwnerFailure', {
    reason: Schema.String,
  });
  const fanout = makeOutboxWorkerLegalEntityScopeFanout(
    backend([active(legalEntityOne), active(legalEntityTwo)], calls),
  );
  return Effect.gen(function* preserveOwnerFailure() {
    const failure = yield* Effect.flip(
      fanout.forEachScope(attestOutboxWorkerHandlerContext(context), ({ legalEntityId }) =>
        Effect.fail(new OwnerFailure({ reason: legalEntityId })),
      ),
    );
    expect(Predicate.isTagged(failure, 'OwnerFailure')).toBe(true);
    expect(calls).toEqual([legalEntityTwo]);
    expect(failure).not.toBeInstanceOf(OutboxWorkerLegalEntityScopeError);
  });
});
