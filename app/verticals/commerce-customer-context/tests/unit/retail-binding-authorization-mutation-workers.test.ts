import type {
  OutboxWorkerCompletionInput,
  OutboxWorkerCompletionPublisher,
  OutboxWorkerHandlerContext,
  OutboxWorkerLegalEntityScopeFanoutService,
} from '@app/core-runtime/outbox/worker';
import { OutboxWorkerLegalEntityScopeFanout } from '@app/core-runtime/outbox/worker';
import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import {
  RetailPortalProfileBindingActivationAuthorizationMutationRequestedPayloadSchema,
  RetailPortalProfileBindingRecoveryAuthorizationMutationRequestedPayloadSchema,
  RetailPortalProfileBindingRevocationAuthorizationMutationRequestedPayloadSchema,
} from '../../shared/actions/bind-retail-portal-profile.ts';
import type { RetailBindingAuthorizationMutationReconciliationService } from '../../src/workers/retail-binding-authorization-mutation-reconciliation.ts';
import { RetailBindingAuthorizationMutationReconciliation } from '../../src/workers/retail-binding-authorization-mutation-reconciliation.ts';
import {
  handleReconcileRetailPortalProfileBindingActivationAuthorizationMutation,
  reconcileRetailPortalProfileBindingActivationAuthorizationMutationWorker,
} from '../../src/workers/reconcile-retail-portal-profile-binding-activation-authorization-mutation.worker.ts';
import {
  handleReconcileRetailPortalProfileBindingRecoveryAuthorizationMutation,
  reconcileRetailPortalProfileBindingRecoveryAuthorizationMutationWorker,
} from '../../src/workers/reconcile-retail-portal-profile-binding-recovery-authorization-mutation.worker.ts';
import {
  handleReconcileRetailPortalProfileBindingRevocationAuthorizationMutation,
  reconcileRetailPortalProfileBindingRevocationAuthorizationMutationWorker,
} from '../../src/workers/reconcile-retail-portal-profile-binding-revocation-authorization-mutation.worker.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '10000000-0000-4000-8000-000000000002';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const mutationId = '60000000-0000-4000-8000-000000000006';
const actionInvocationId = '50000000-0000-4000-8000-000000000005';
const occurredAt = new Date('2026-09-09T10:00:00.000Z');
const bindingRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'binding-1',
  resourceType: 'commerce.customer-context.retail-portal-profile-binding',
  tenantId,
} as const;
const profileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'retail-profile-1',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const principalRef = {
  moduleId: 'core.identity',
  resourceId: '30000000-0000-4000-8000-000000000003',
  resourceType: 'core.identity.principal',
  tenantId,
} as const;
const sellingLegalEntityRef = {
  moduleId: 'core.identity',
  resourceId: legalEntityId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;

const commonRequest = {
  bindingRef,
  catalogVersion: '1',
  legalEntityId,
  mutationId,
  principalRef,
  profileRef,
  schemaVersion: '1',
  sellingLegalEntityRef,
} as const;
const activationRequest = Schema.decodeUnknownSync(
  RetailPortalProfileBindingActivationAuthorizationMutationRequestedPayloadSchema,
)({ ...commonRequest, operation: 'grant', transition: 'activation' });
const recoveryRequest = Schema.decodeUnknownSync(
  RetailPortalProfileBindingRecoveryAuthorizationMutationRequestedPayloadSchema,
)({ ...commonRequest, operation: 'grant', transition: 'recovery' });
const revocationRequest = Schema.decodeUnknownSync(
  RetailPortalProfileBindingRevocationAuthorizationMutationRequestedPayloadSchema,
)({ ...commonRequest, operation: 'revoke', transition: 'revocation' });

const contextFor = (transition: 'activation' | 'recovery' | 'revocation') =>
  ({
    actorPrincipalId: principalRef.resourceId,
    attemptNumber: 1,
    claimId: 'claim-1',
    consumerModuleKey: 'commerce.customer-context',
    deliveryId: 'delivery-1',
    domainEventId: 'event-1',
    messageId: 'message-1',
    producerModuleKey: 'commerce.customer-context',
    tenantId,
    tenantSequenceNo: 1n,
    topic: `commerce.customer-context.retail-portal-profile-binding-${transition}-authorization-mutation-requested.v1`,
    workerKey: `commerce.customer-context.reconcile-retail-portal-profile-binding-${transition}-authorization-mutation`,
  }) as const satisfies OutboxWorkerHandlerContext;

const unavailableInvoker = {
  invoke: () => Effect.die(new Error('Worker contract tests do not invoke owner routines')),
};

const fanout = (
  completionPublisher: OutboxWorkerCompletionPublisher,
  selectedLegalEntityId = legalEntityId,
  callbackCompleted?: { value: boolean },
): OutboxWorkerLegalEntityScopeFanoutService => ({
  forEachScope: (workerContext, observe) =>
    Effect.gen(function* observeScope() {
      yield* observe({
        completionPublisher,
        legalEntityId: selectedLegalEntityId,
        routineInvoker: unavailableInvoker,
        tenantId: workerContext.tenantId,
      });
      if (callbackCompleted !== undefined) {
        callbackCompleted.value = true;
      }
    }),
});

const publisher = (
  capture?: (input: OutboxWorkerCompletionInput<unknown>) => void,
): OutboxWorkerCompletionPublisher => ({
  publish: (_definition, input) => {
    capture?.(input);
    return Effect.succeed({ domainEventId: input.completionId, outcome: 'PUBLISHED' as const });
  },
});

const provideWorkerServices = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  service: RetailBindingAuthorizationMutationReconciliationService,
  completionPublisher: OutboxWorkerCompletionPublisher,
) =>
  effect.pipe(
    Effect.provideService(RetailBindingAuthorizationMutationReconciliation, service),
    Effect.provideService(OutboxWorkerLegalEntityScopeFanout, fanout(completionPublisher)),
  );

const activePayload = {
  bindingRef,
  effectiveAt: '2026-09-09T10:00:00.000Z',
  principalRef,
  profileRef,
  revision: 2,
  sellingLegalEntityRef,
  state: 'ACTIVE',
} as const;
const revokedPayload = { ...activePayload, state: 'REVOKED' as const };

it.effect('publishes each exact terminal binding fact only after durable finalization', () => {
  const published: OutboxWorkerCompletionInput<unknown>[] = [];
  const completionPublisher = publisher((input) => {
    published.push(input);
  });
  return Effect.gen(function* finalizedTransitions() {
    yield* provideWorkerServices(
      handleReconcileRetailPortalProfileBindingActivationAuthorizationMutation(
        activationRequest,
        contextFor('activation'),
      ),
      {
        reconcile: () =>
          Effect.succeed({
            outcome: 'FINALIZED',
            terminal: {
              completionId: mutationId,
              kind: 'ACTIVATION',
              occurredAt,
              payload: activePayload,
              sourceActionInvocationId: actionInvocationId,
            },
          }),
      },
      completionPublisher,
    );
    yield* provideWorkerServices(
      handleReconcileRetailPortalProfileBindingRecoveryAuthorizationMutation(recoveryRequest, contextFor('recovery')),
      {
        reconcile: () =>
          Effect.succeed({
            outcome: 'ALREADY_FINAL',
            terminal: {
              completionId: mutationId,
              kind: 'RECOVERY',
              occurredAt,
              payload: activePayload,
              sourceActionInvocationId: actionInvocationId,
            },
          }),
      },
      completionPublisher,
    );
    yield* provideWorkerServices(
      handleReconcileRetailPortalProfileBindingRevocationAuthorizationMutation(
        revocationRequest,
        contextFor('revocation'),
      ),
      {
        reconcile: () =>
          Effect.succeed({
            outcome: 'FINALIZED',
            terminal: {
              completionId: mutationId,
              kind: 'REVOCATION',
              occurredAt,
              payload: revokedPayload,
              sourceActionInvocationId: actionInvocationId,
            },
          }),
      },
      completionPublisher,
    );
    expect(published).toHaveLength(3);
    expect(published.map(({ payloadJson }) => payloadJson)).toEqual([activePayload, activePayload, revokedPayload]);
    expect(published.every(({ completionId }) => completionId === mutationId)).toBe(true);
    expect(published.every(({ sourceActionInvocationId }) => sourceActionInvocationId === actionInvocationId)).toBe(
      true,
    );
  });
});

it.effect('fails the delivery after committing an indeterminate scoped reconciliation attempt', () => {
  const callbackCompleted = { value: false };
  return Effect.gen(function* indeterminateMutation() {
    const failure = yield* Effect.flip(
      handleReconcileRetailPortalProfileBindingActivationAuthorizationMutation(
        activationRequest,
        contextFor('activation'),
      ).pipe(
        Effect.provideService(RetailBindingAuthorizationMutationReconciliation, {
          reconcile: () => Effect.succeed({ outcome: 'INDETERMINATE' }),
        }),
        Effect.provideService(
          OutboxWorkerLegalEntityScopeFanout,
          fanout(publisher(), legalEntityId, callbackCompleted),
        ),
      ),
    );
    expect(callbackCompleted.value).toBe(true);
    expect(failure.code).toBe('RECONCILIATION_INDETERMINATE');
  });
});

it.effect('rejects a cross-Tenant trigger before owner reconciliation', () => {
  let reconcileCalls = 0;
  // SAFETY: This adversarial unit test bypasses payload decoding to prove the handler's independent Tenant guard.
  const foreignRequest = {
    ...activationRequest,
    profileRef: { ...profileRef, tenantId: otherTenantId },
  } as Parameters<typeof handleReconcileRetailPortalProfileBindingActivationAuthorizationMutation>[0];
  return Effect.gen(function* crossTenantTrigger() {
    const failure = yield* Effect.flip(
      provideWorkerServices(
        handleReconcileRetailPortalProfileBindingActivationAuthorizationMutation(
          foreignRequest,
          contextFor('activation'),
        ),
        {
          reconcile: () => {
            reconcileCalls += 1;
            return Effect.succeed({ outcome: 'INDETERMINATE' });
          },
        },
        publisher(),
      ),
    );
    expect(failure.code).toBe('CROSS_TENANT_REQUEST');
    expect(reconcileCalls).toBe(0);
  });
});

it.effect('rejects mismatched terminal evidence without publishing a false completion', () => {
  let publishCalls = 0;
  return Effect.gen(function* mismatchedTerminal() {
    const failure = yield* Effect.flip(
      provideWorkerServices(
        handleReconcileRetailPortalProfileBindingActivationAuthorizationMutation(
          activationRequest,
          contextFor('activation'),
        ),
        {
          reconcile: () =>
            Effect.succeed({
              outcome: 'FINALIZED',
              terminal: {
                completionId: mutationId,
                kind: 'ACTIVATION',
                occurredAt,
                payload: {
                  ...activePayload,
                  bindingRef: { ...bindingRef, resourceId: 'another-binding' },
                },
                sourceActionInvocationId: actionInvocationId,
              },
            }),
        },
        publisher(() => {
          publishCalls += 1;
        }),
      ),
    );
    expect(failure.code).toBe('RECONCILIATION_RESULT_INVALID');
    expect(publishCalls).toBe(0);
  });
});

it('publishes a fail-closed request schema and three exact owner-local workers', () => {
  const malformed = {
    ...activationRequest,
    sellingLegalEntityRef: { ...sellingLegalEntityRef, resourceId: otherTenantId },
  };
  expect(() =>
    Schema.decodeUnknownSync(RetailPortalProfileBindingActivationAuthorizationMutationRequestedPayloadSchema)(
      malformed,
    ),
  ).toThrow();

  const workers = [
    reconcileRetailPortalProfileBindingActivationAuthorizationMutationWorker,
    reconcileRetailPortalProfileBindingRecoveryAuthorizationMutationWorker,
    reconcileRetailPortalProfileBindingRevocationAuthorizationMutationWorker,
  ];
  expect(workers).toHaveLength(3);
  expect(
    workers.every(
      ({ descriptor }) =>
        descriptor.consumerModuleKey === 'commerce.customer-context' &&
        descriptor.entrypoint.authorization.kind === 'owner_local_background' &&
        descriptor.entrypoint.role === 'worker',
    ),
  ).toBe(true);
  expect(new Set(workers.map(({ descriptor }) => descriptor.topic)).size).toBe(3);
});
