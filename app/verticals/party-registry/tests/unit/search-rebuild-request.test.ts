import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Schema, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { PartySearchProjectionUnavailable } from '../../shared/domain/search-projection-error.ts';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { PartySearchProjector } from '../../src/services/party-search-projection.service.ts';
import {
  handleRebuildSearch,
  rebuildSearchWorker,
} from '../../src/workers/rebuild-search.worker.ts';

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
  transport: {
    correlationId: 'search-rebuild-test',
    idempotencyKey: 'rebuild-1',
  },
};

it.effect(
  'tenant rebuild requests require Party administration and canonical idempotency',
  () =>
    Effect.gen(function* rebuildDescriptor() {
      const { descriptor } = requestSearchRebuildAction;
      expect(descriptor.actionKey).toBe(
        'party.registry.request-search-rebuild'
      );
      expect(descriptor.tenantPermission?.({})).toBe('manage_party_identity');
      expect(descriptor.idempotency).toBe('required');
      expect(descriptor.legalEntityScope).toBe('optional');
      expect(descriptor.entrypoint.scope).toBe('tenant');
      expect(
        yield* Schema.decodeUnknownEffect(descriptor.payloadSchema)({})
      ).toEqual({});
      expect(Object.keys(descriptor.domainEvents)).toEqual([
        'party.registry.search-rebuild-requested.v1',
      ]);
    })
);

it.effect(
  'authorized rebuild commits one linked request without reading identity or running the projector',
  () =>
    Effect.gen(function* authorizedRebuildRequest() {
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        tenantPermission: 'allowed',
      });
      const result = yield* harness.runtime.runAction(request);
      expect(result.status).toBe('QUEUED');
      expect(
        Schema.is(Schema.String.check(Schema.isUUID()))(result.requestId)
      ).toBe(true);
      const { committed, permissionDenials } = harness.snapshot();
      expect(committed.length).toBe(1);
      expect(permissionDenials).toEqual([]);
      expect(committed[0]?.evidence.dataAccessEvents).toEqual([]);
      expect(committed[0]?.evidence.domainEvents).toEqual([
        {
          eventType: 'party.registry.search-rebuild-requested.v1',
          payloadJson: { requestId: result.requestId },
          producerModuleKey: 'party.registry',
          subjectModuleKey: 'core.identity',
          subjectResourceId: tenantId,
          subjectResourceType: 'tenant',
        },
      ]);
      expect(committed[0]?.evidence.outboxMessages).toEqual([
        {
          domainEventIndex: 0,
          message: {
            payloadJson: { requestId: result.requestId },
            producerModuleKey: 'party.registry',
            topic: 'party.registry.search-rebuild-requested.v1',
          },
        },
      ]);
    })
);

it.effect(
  'denied Party administration cannot queue a rebuild even with Action execution permission',
  () =>
    Effect.gen(function* deniedRebuildRequest() {
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        tenantPermission: 'denied',
      });
      const error = yield* harness.runtime.runAction(request).pipe(Effect.flip);
      expect(Predicate.isTagged(error, 'ActionPermissionDenied')).toBe(true);
      const snapshot = harness.snapshot();
      expect(snapshot.committed).toEqual([]);
      expect(snapshot.permissionDenials.length).toBe(1);
      expect(snapshot.stages.includes('handler_executed')).toBe(false);
    })
);

it.effect(
  'replaying the same authorized rebuild request queues only once',
  () =>
    Effect.gen(function* replayRebuildRequest() {
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        tenantPermission: 'allowed',
      });
      yield* harness.runtime.runAction(request);
      const replay = yield* harness.runtime
        .runAction(request)
        .pipe(Effect.flip);
      expect(Predicate.isTagged(replay, 'ActionAlreadyCommitted')).toBe(true);
      const snapshot = harness.snapshot();
      expect(snapshot.committed.length).toBe(1);
      expect(snapshot.committed[0]?.evidence.domainEvents.length).toBe(1);
      expect(snapshot.committed[0]?.evidence.outboxMessages.length).toBe(1);
      expect(snapshot.invocations.length).toBe(1);
    })
);

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

it.effect(
  'rebuild worker uses its trusted committed context, and failures remain retryable',
  () => {
    const unavailable = new PartySearchProjectionUnavailable({
      code: 'party_search_projection_unavailable',
      reason: 'Party search projection is temporarily unavailable',
    });
    return Effect.gen(function* rebuildWorkerFailure() {
      const failure = yield* handleRebuildSearch(
        { requestId },
        workerContext
      ).pipe(
        Effect.provideService(PartySearchProjector, {
          project: (context, target) => {
            expect(context).toBe(workerContext);
            expect(target).toEqual({ rebuild: true });
            return Effect.fail(unavailable);
          },
        }),
        Effect.flip
      );
      expect(failure).toBe(unavailable);
      expect(rebuildSearchWorker.descriptor.workerKey).toBe(
        'party.registry.rebuild-search'
      );
      expect(rebuildSearchWorker.descriptor.topic).toBe(
        'party.registry.search-rebuild-requested.v1'
      );
    });
  }
);
