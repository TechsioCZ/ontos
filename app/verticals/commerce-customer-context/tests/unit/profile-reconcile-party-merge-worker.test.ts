import type {
  OutboxWorkerHandlerContext,
  OutboxWorkerLegalEntityScope,
  OutboxWorkerLegalEntityScopeFanoutService,
} from '@app/core-runtime';
import { OutboxWorkerLegalEntityScopeError, OutboxWorkerLegalEntityScopeFanout } from '@app/core-runtime';
import type { OutboxPayload } from '@app/party-registry/outbox/party-registry-party-merged-v1';
import { expect, it } from 'effect-rstest';
import { Effect, Predicate, Schema } from 'effect';
import { RECONCILIATION_REQUIRED_OWNERS } from '../../shared/domain/profile-contracts.ts';
import { ProfileReconciliationCaseRefSchema } from '../../shared/resources/profile-reconciliation-case.ts';
import {
  ReconcilePartyMergePersistence,
  ReconcilePartyMergeWorkerRejected,
  handleReconcilePartyMerge,
  reconcilePartyMergePersistenceUnavailable,
} from '../../src/workers/reconcile-party-merge.worker.ts';
import type {
  ReconcilePartyMergeObservation,
  ReconcilePartyMergeObservationResult,
  ReconcilePartyMergePersistenceService,
} from '../../src/workers/reconcile-party-merge.worker.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '20000000-0000-4000-8000-000000000002';
const legalEntityId = '30000000-0000-4000-8000-000000000003';
const otherLegalEntityId = '30000000-0000-4000-8000-000000000004';

const partyRef = (resourceId: string, refTenantId = tenantId) =>
  ({
    moduleId: 'party.registry',
    resourceId,
    resourceType: 'party.registry.party',
    tenantId: refTenantId,
  }) as const;

const payload: OutboxPayload = {
  absorbedPartyRefs: [partyRef('absorbed-party-1')],
  mergeId: 'merge-1',
  occurredAt: '2026-09-09T10:00:00.000Z',
  policyVersion: 'party-merge-policy-v1',
  survivorPartyRef: partyRef('survivor-party-1'),
  tenantId,
};

const context: OutboxWorkerHandlerContext = {
  actorPrincipalId: '40000000-0000-4000-8000-000000000004',
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
};

const persistence = (
  result: ReconcilePartyMergeObservationResult,
  capture?: (observation: ReconcilePartyMergeObservation) => void,
): ReconcilePartyMergePersistenceService => ({
  observe: (_scope, observation) => {
    capture?.(observation);
    return Effect.succeed(result);
  },
});

const unavailableInvoker: OutboxWorkerLegalEntityScope['routineInvoker'] = {
  invoke: () => Effect.die(new Error('The worker unit test does not execute routines')),
};

const fanout = (legalEntityIds: readonly string[] = [legalEntityId]): OutboxWorkerLegalEntityScopeFanoutService => ({
  forEachScope: (workerContext, observe) =>
    Effect.forEach(
      legalEntityIds,
      (scopeLegalEntityId) =>
        observe({
          completionPublisher: {
            publish: () => Effect.die(new Error('The worker unit test does not publish completion events')),
          },
          legalEntityId: scopeLegalEntityId,
          routineInvoker: unavailableInvoker,
          tenantId: workerContext.tenantId,
        }),
      { concurrency: 1, discard: true },
    ),
});

const runWorker = (
  workerPayload: OutboxPayload,
  workerContext: OutboxWorkerHandlerContext,
  service: ReconcilePartyMergePersistenceService,
  scopeFanout: OutboxWorkerLegalEntityScopeFanoutService = fanout(),
) =>
  handleReconcilePartyMerge(workerPayload, workerContext).pipe(
    Effect.provideService(ReconcilePartyMergePersistence, service),
    Effect.provideService(OutboxWorkerLegalEntityScopeFanout, scopeFanout),
  );

const retailProfileRef = (resourceId: string) =>
  ({
    kind: 'RETAIL',
    moduleId: 'commerce.customer-context',
    resourceId,
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  }) as const;

const reconciliationCaseRef = Schema.decodeUnknownSync(ProfileReconciliationCaseRefSchema)({
  moduleId: 'commerce.customer-context',
  resourceId: 'case-1',
  resourceType: 'commerce.customer-context.profile-reconciliation-case',
  tenantId,
});

const pendingOwnerOutcomes = () =>
  RECONCILIATION_REQUIRED_OWNERS.map((owner) => ({ owner, status: 'PENDING' as const }));

it.effect('acknowledges a durable duplicate without opening another reconciliation case', () => {
  let observation: ReconcilePartyMergeObservation | undefined;
  return Effect.gen(function* duplicatePartyMerge() {
    yield* runWorker(
      payload,
      context,
      persistence({ currentEventVersion: context.tenantSequenceNo, outcome: 'DUPLICATE' }, (value) => {
        observation = value;
      }),
    );
    expect(observation?.mergeId).toBe(payload.mergeId);
    expect(observation?.domainEventId).toBe(context.domainEventId);
    expect(observation?.messageId).toBe(context.messageId);
  });
});

it.effect('acknowledges an out-of-order event only behind a strictly newer durable version', () =>
  Effect.gen(function* outOfOrderPartyMerge() {
    yield* runWorker(payload, context, persistence({ currentEventVersion: 11n, outcome: 'OUT_OF_ORDER' }));
    const failure = yield* Effect.flip(
      runWorker(payload, context, persistence({ currentEventVersion: 10n, outcome: 'OUT_OF_ORDER' })),
    );
    expect(failure.code).toBe('CURRENT_STATE_CONFLICT');
    expect(failure.retryable).toBe(true);
  }),
);

it.effect('rejects cross-Tenant delivery evidence before persistence is invoked', () => {
  let calls = 0;
  return Effect.gen(function* crossTenantPartyMerge() {
    const failure = yield* Effect.flip(
      runWorker(
        payload,
        { ...context, tenantId: otherTenantId },
        {
          observe: () => {
            calls += 1;
            return Effect.succeed({
              currentEventVersion: context.tenantSequenceNo,
              outcome: 'NO_CONFLICTING_PROFILES',
            });
          },
        },
      ),
    );
    expect(failure.code).toBe('CROSS_TENANT_EVENT');
    expect(failure.retryable).toBe(false);
    expect(calls).toBe(0);
  });
});

it.effect('rejects delivery evidence without a verified originating actor', () => {
  let calls = 0;
  const { actorPrincipalId: _actorPrincipalId, ...withoutActor } = context;
  return Effect.gen(function* missingActor() {
    const failure = yield* Effect.flip(
      runWorker(payload, withoutActor, {
        observe: () => {
          calls += 1;
          return Effect.succeed({
            currentEventVersion: context.tenantSequenceNo,
            outcome: 'NO_CONFLICTING_PROFILES',
          });
        },
      }),
    );
    expect(failure.code).toBe('WORKER_CONTEXT_INVALID');
    expect(failure.retryable).toBe(false);
    expect(calls).toBe(0);
  });
});

it.effect('opens fail-closed Retail reconciliation with every required owner pending', () => {
  let observation: ReconcilePartyMergeObservation | undefined;
  return Effect.gen(function* conflictingRetailProfiles() {
    yield* runWorker(
      payload,
      context,
      persistence(
        {
          cases: [
            {
              caseRef: reconciliationCaseRef,
              change: 'OPENED',
              conflictingProfiles: [retailProfileRef('profile-1'), retailProfileRef('profile-2')],
              legalEntityId,
              ownerOutcomes: pendingOwnerOutcomes(),
            },
          ],
          currentEventVersion: context.tenantSequenceNo,
          outcome: 'RECONCILIATIONS_OBSERVED',
        },
        (value) => {
          observation = value;
        },
      ),
    );
    expect(observation?.initialOwnerOutcomes).toEqual(pendingOwnerOutcomes());
    expect(observation?.absorbedPartyRefs).toEqual(payload.absorbedPartyRefs);
    expect(observation?.survivorPartyRef).toEqual(payload.survivorPartyRef);
  });
});

it.effect('rejects any persistence result that silently pre-resolves owner state', () => {
  let observationKeys: string[] = [];
  const unsafeOutcomes = pendingOwnerOutcomes().map((outcome, index) =>
    index === 0 ? { ...outcome, evidenceRef: 'unsafe-union', status: 'RESOLVED' as const } : outcome,
  );
  return Effect.gen(function* noSilentUnion() {
    const failure = yield* Effect.flip(
      runWorker(
        payload,
        context,
        persistence(
          {
            cases: [
              {
                caseRef: reconciliationCaseRef,
                change: 'OPENED',
                conflictingProfiles: [retailProfileRef('profile-1'), retailProfileRef('profile-2')],
                legalEntityId,
                ownerOutcomes: unsafeOutcomes,
              },
            ],
            currentEventVersion: context.tenantSequenceNo,
            outcome: 'RECONCILIATIONS_OBSERVED',
          },
          (value) => {
            observationKeys = Object.keys(value);
          },
        ),
      ),
    );
    expect(failure.code).toBe('CURRENT_STATE_CONFLICT');
    expect(observationKeys).not.toContain('survivorProfileRef');
    expect(observationKeys).not.toContain('resultingState');
    expect(observationKeys).not.toContain('permissions');
    expect(observationKeys).not.toContain('history');
  });
});

it.effect('rejects a persistence case attributed to a different legal-entity scope', () =>
  Effect.gen(function* rejectCrossScopeResult() {
    const failure = yield* Effect.flip(
      runWorker(
        payload,
        context,
        persistence({
          cases: [
            {
              caseRef: reconciliationCaseRef,
              change: 'OPENED',
              conflictingProfiles: [retailProfileRef('profile-1'), retailProfileRef('profile-2')],
              legalEntityId: otherLegalEntityId,
              ownerOutcomes: pendingOwnerOutcomes(),
            },
          ],
          currentEventVersion: context.tenantSequenceNo,
          outcome: 'RECONCILIATIONS_OBSERVED',
        }),
      ),
    );
    expect(failure.code).toBe('CURRENT_STATE_CONFLICT');
    expect(failure.retryable).toBe(true);
  }),
);

it.effect('keeps the generated worker fail closed until durable persistence is injected', () =>
  Effect.gen(function* unavailablePersistence() {
    const failure = yield* Effect.flip(runWorker(payload, context, reconcilePartyMergePersistenceUnavailable));
    expect(Predicate.isTagged(failure, 'ReconcilePartyMergeWorkerRejected')).toBe(true);
    expect(failure).toBeInstanceOf(ReconcilePartyMergeWorkerRejected);
    expect(failure.code).toBe('PERSISTENCE_UNAVAILABLE');
    expect(failure.retryable).toBe(true);
  }),
);

it.effect('observes the event independently in every Core-verified legal-entity scope', () => {
  const observed: ReconcilePartyMergeObservation[] = [];
  return Effect.gen(function* fanOutPartyMerge() {
    yield* runWorker(
      payload,
      context,
      persistence({ currentEventVersion: context.tenantSequenceNo, outcome: 'DUPLICATE' }, (observation) => {
        observed.push(observation);
      }),
      fanout([otherLegalEntityId, legalEntityId]),
    );
    expect(observed.map(({ legalEntityId: observedLegalEntityId }) => observedLegalEntityId)).toEqual([
      otherLegalEntityId,
      legalEntityId,
    ]);
    expect(observed.every(({ tenantId: observedTenantId }) => observedTenantId === tenantId)).toBe(true);
  });
});

it.effect('fails closed when Core cannot verify any legal-entity scope', () => {
  let persistenceCalls = 0;
  const emptyFanout: OutboxWorkerLegalEntityScopeFanoutService = {
    forEachScope: () =>
      Effect.fail(
        new OutboxWorkerLegalEntityScopeError({
          code: 'outbox_worker_scope_empty',
          reason: 'No legal-entity scope',
          retryable: true,
        }),
      ),
  };
  return Effect.gen(function* emptyScopeFailsClosed() {
    const failure = yield* Effect.flip(
      runWorker(
        payload,
        context,
        {
          observe: () => {
            persistenceCalls += 1;
            return Effect.succeed({
              currentEventVersion: context.tenantSequenceNo,
              outcome: 'NO_CONFLICTING_PROFILES',
            });
          },
        },
        emptyFanout,
      ),
    );
    expect(failure.code).toBe('PERSISTENCE_UNAVAILABLE');
    expect(failure.retryable).toBe(true);
    expect(persistenceCalls).toBe(0);
  });
});
