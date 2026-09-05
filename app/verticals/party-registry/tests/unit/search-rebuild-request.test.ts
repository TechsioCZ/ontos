import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import {
  handleRebuildSearch,
  rebuildSearchWorker,
} from '../../src/workers/rebuild-search.worker.ts';
import { PartySearchProjector } from '../../src/services/party-search-projection.service.ts';
import { PartySearchProjectionUnavailable } from '../../shared/domain/search-projection-error.ts';

const requestId = '40000000-0000-4000-8000-000000000001';
const tenantId = '20000000-0000-4000-8000-000000000001';
const principal = {
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:search-rebuild-test',
  authMethod: 'session',
  principalId: '50000000-0000-4000-8000-000000000001',
  tenantId,
} as const;
const request = {
  payload: {},
  principal,
  registration: requestSearchRebuildAction,
  transport: { correlationId: 'search-rebuild-test', idempotencyKey: 'rebuild-1' },
};

test('tenant rebuild requests require Party administration and canonical idempotency', () => {
  const { descriptor } = requestSearchRebuildAction;
  assert.equal(descriptor.actionKey, 'party.registry.request-search-rebuild');
  assert.equal(descriptor.tenantPermission?.({}), 'manage_party_identity');
  assert.equal(descriptor.idempotency, 'required');
  assert.equal(descriptor.legalEntityScope, 'optional');
  assert.equal(descriptor.entrypoint.scope, 'tenant');
  assert.deepEqual(Schema.decodeUnknownSync(descriptor.payloadSchema)({}), {});
  assert.deepEqual(Object.keys(descriptor.domainEvents), [
    'party.registry.search-rebuild-requested.v1',
  ]);
});

test('authorized rebuild commits one linked request without reading identity or running the projector', () => {
  const harness = makeActionTestHarness({
    actionPermission: 'allowed',
    tenantPermission: 'allowed',
  });
  return Effect.runPromise(
    Effect.gen(function* authorizedRebuildRequest() {
      const result = yield* harness.runtime.runAction(request);
      assert.equal(result.status, 'QUEUED');
      assert.equal(Schema.is(Schema.String.check(Schema.isUUID()))(result.requestId), true);
      const { committed, permissionDenials } = harness.snapshot();
      assert.equal(committed.length, 1);
      assert.deepEqual(permissionDenials, []);
      assert.deepEqual(committed[0]?.evidence.dataAccessEvents, []);
      assert.deepEqual(committed[0]?.evidence.domainEvents, [
        {
          eventType: 'party.registry.search-rebuild-requested.v1',
          payloadJson: { requestId: result.requestId },
          producerModuleKey: 'party.registry',
          subjectModuleKey: 'core.identity',
          subjectResourceId: tenantId,
          subjectResourceType: 'tenant',
        },
      ]);
      assert.deepEqual(committed[0]?.evidence.outboxMessages, [
        {
          domainEventIndex: 0,
          message: {
            payloadJson: { requestId: result.requestId },
            producerModuleKey: 'party.registry',
            topic: 'party.registry.search-rebuild-requested.v1',
          },
        },
      ]);
    }),
  );
});

test('denied Party administration cannot queue a rebuild even with Action execution permission', () => {
  const harness = makeActionTestHarness({
    actionPermission: 'allowed',
    tenantPermission: 'denied',
  });
  return Effect.runPromise(
    Effect.gen(function* deniedRebuildRequest() {
      const error = yield* harness.runtime.runAction(request).pipe(Effect.flip);
      assert.equal(error._tag, 'ActionPermissionDenied');
      const snapshot = harness.snapshot();
      assert.deepEqual(snapshot.committed, []);
      assert.equal(snapshot.permissionDenials.length, 1);
      assert.equal(snapshot.stages.includes('handler_executed'), false);
    }),
  );
});

test('replaying the same authorized rebuild request queues only once', () => {
  const harness = makeActionTestHarness({
    actionPermission: 'allowed',
    tenantPermission: 'allowed',
  });
  return Effect.runPromise(
    Effect.gen(function* replayRebuildRequest() {
      yield* harness.runtime.runAction(request);
      const replay = yield* harness.runtime.runAction(request).pipe(Effect.flip);
      assert.equal(replay._tag, 'ActionAlreadyCommitted');
      const snapshot = harness.snapshot();
      assert.equal(snapshot.committed.length, 1);
      assert.equal(snapshot.committed[0]?.evidence.domainEvents.length, 1);
      assert.equal(snapshot.committed[0]?.evidence.outboxMessages.length, 1);
      assert.equal(snapshot.invocations.length, 1);
    }),
  );
});

const workerContext: OutboxWorkerHandlerContext = {
  attemptNumber: 1,
  claimId: 'claim-1',
  deliveryId: 'delivery-1',
  domainEventId: 'event-1',
  messageId: 'message-1',
  producerModuleKey: 'party.registry',
  tenantId,
  tenantSequenceNo: 50n,
  topic: 'party.registry.search-rebuild-requested.v1',
  workerKey: 'party.registry.rebuild-search',
};

test('rebuild worker uses its trusted committed context, and failures remain retryable', () => {
  const unavailable = new PartySearchProjectionUnavailable({
    code: 'party_search_projection_unavailable',
    reason: 'Party search projection is temporarily unavailable',
  });
  return Effect.runPromise(
    Effect.gen(function* rebuildWorkerFailure() {
      const failure = yield* handleRebuildSearch({ requestId }, workerContext).pipe(
        Effect.provideService(PartySearchProjector, {
          project: (context, target) => {
            assert.equal(context, workerContext);
            assert.deepEqual(target, { rebuild: true });
            return Effect.fail(unavailable);
          },
        }),
        Effect.flip,
      );
      assert.equal(failure, unavailable);
      assert.equal(rebuildSearchWorker.descriptor.workerKey, 'party.registry.rebuild-search');
      assert.equal(
        rebuildSearchWorker.descriptor.topic,
        'party.registry.search-rebuild-requested.v1',
      );
    }),
  );
});
