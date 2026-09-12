import type {
  OutboxWorkerCompletionInput,
  OutboxWorkerCompletionPublisher,
  OutboxWorkerHandlerContext,
  OutboxWorkerLegalEntityScopeFanoutService,
} from '@app/core-runtime/outbox/worker';
import { OutboxWorkerLegalEntityScopeFanout } from '@app/core-runtime/outbox/worker';
import { expect, it } from 'effect-rstest';
import { DateTime, Effect } from 'effect';
import { AccessAuthorizationMutationReconciliation } from '../../src/workers/access-authorization-mutation-reconciliation.ts';
import type { AccessAuthorizationMutationReconciliationService } from '../../src/workers/access-authorization-mutation-reconciliation.ts';
import {
  handleReconcileCounterpartyAccessGrantAuthorizationMutation,
  reconcileCounterpartyAccessGrantAuthorizationMutationWorker,
} from '../../src/workers/reconcile-counterparty-access-grant-authorization-mutation.worker.ts';
import {
  handleReconcileCounterpartyAccessInvitationClaimAuthorizationMutation,
  reconcileCounterpartyAccessInvitationClaimAuthorizationMutationWorker,
} from '../../src/workers/reconcile-counterparty-access-invitation-claim-authorization-mutation.worker.ts';
import { reconcileCounterpartyAccessAdministratorBootstrapAuthorizationMutationWorker } from '../../src/workers/reconcile-counterparty-access-administrator-bootstrap-authorization-mutation.worker.ts';
import { reconcileCounterpartyAccessRevokeAuthorizationMutationWorker } from '../../src/workers/reconcile-counterparty-access-revoke-authorization-mutation.worker.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '10000000-0000-4000-8000-000000000002';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const mutationId = '60000000-0000-4000-8000-000000000006';
const actionInvocationId = '50000000-0000-4000-8000-000000000005';
const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-09T10:00:00.000Z'));
const actor = { principalId: '30000000-0000-4000-8000-000000000003', tenantId } as const;
const recipient = { principalId: '40000000-0000-4000-8000-000000000004', tenantId } as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: 'counterparty-1',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const grantRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'grant-1',
  resourceType: 'commerce.customer-context.counterparty-commerce-access-grant',
  tenantId,
} as const;
const invitationRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'invitation-1',
  resourceType: 'commerce.customer-context.counterparty-access-invitation',
  tenantId,
} as const;
const scope = { kind: 'counterparty' } as const;

const request = {
  catalogVersion: '1',
  counterpartyRef,
  grantRef,
  legalEntityId,
  mutationId,
  operation: 'grant',
  schemaVersion: '1',
} as const;

const context: OutboxWorkerHandlerContext = {
  actorPrincipalId: actor.principalId,
  attemptNumber: 1,
  claimId: 'claim-1',
  consumerModuleKey: 'commerce.customer-context',
  deliveryId: 'delivery-1',
  domainEventId: 'event-1',
  messageId: 'message-1',
  producerModuleKey: 'commerce.customer-context',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'commerce.customer-context.counterparty-access-grant-authorization-mutation-requested.v1',
  workerKey: 'commerce.customer-context.reconcile-counterparty-access-grant-authorization-mutation',
};

const unavailableInvoker = {
  invoke: () => Effect.die(new Error('Worker contract tests do not execute owner routines')),
};

const fanout = (
  completionPublisher: OutboxWorkerCompletionPublisher,
  callbackCompleted?: { value: boolean },
): OutboxWorkerLegalEntityScopeFanoutService => ({
  forEachScope: (workerContext, observe) =>
    Effect.gen(function* observeScope() {
      yield* observe({
        completionPublisher,
        legalEntityId,
        routineInvoker: unavailableInvoker,
        tenantId: workerContext.tenantId,
      });
      if (callbackCompleted !== undefined) {
        callbackCompleted.value = true;
      }
    }),
});

const runGrant = (
  service: AccessAuthorizationMutationReconciliationService,
  completionPublisher: OutboxWorkerCompletionPublisher,
  workerRequest: Parameters<typeof handleReconcileCounterpartyAccessGrantAuthorizationMutation>[0] = request,
  workerContext: OutboxWorkerHandlerContext = context,
) =>
  handleReconcileCounterpartyAccessGrantAuthorizationMutation(workerRequest, workerContext).pipe(
    Effect.provideService(AccessAuthorizationMutationReconciliation, service),
    Effect.provideService(OutboxWorkerLegalEntityScopeFanout, fanout(completionPublisher)),
  );

const publisher = (
  capture?: (input: OutboxWorkerCompletionInput<unknown>) => void,
): OutboxWorkerCompletionPublisher => ({
  publish: (_definition, input) => {
    capture?.(input);
    return Effect.succeed({ domainEventId: input.completionId, outcome: 'PUBLISHED' as const });
  },
});

const terminalGrant = {
  catalogVersion: '1',
  counterpartyRef,
  grantedAt: '2026-09-09T09:59:00.000Z',
  grantedBy: actor,
  grantRef,
  permission: 'counterparty.purchase.prepare',
  recipient,
  revision: 2,
  scope,
  state: 'ACTIVE',
} as const;

it.effect('publishes the exact grant completion only after durable finalization', () => {
  let published: OutboxWorkerCompletionInput<unknown> | undefined;
  return Effect.gen(function* finalizedGrant() {
    yield* runGrant(
      {
        reconcile: () =>
          Effect.succeed({
            outcome: 'FINALIZED',
            terminal: {
              completionId: mutationId,
              grant: terminalGrant,
              kind: 'GRANT',
              occurredAt,
              sourceActionInvocationId: actionInvocationId,
            },
          }),
      },
      publisher((input) => {
        published = input;
      }),
    );
    expect(published?.completionId).toBe(mutationId);
    expect(published?.sourceActionInvocationId).toBe(actionInvocationId);
    expect(published?.payloadJson).toEqual({
      catalogVersion: '1',
      counterpartyRef,
      grantedAt: '2026-09-09T10:00:00.000Z',
      grantedBy: actor,
      grantRef,
      permission: 'counterparty.purchase.prepare',
      recipient,
      revision: 2,
      scope,
    });
  });
});

it.effect('commits indeterminate owner progress before failing the delivery for retry', () => {
  const callbackCompleted = { value: false };
  const scopeFanout = fanout(publisher(), callbackCompleted);
  return Effect.gen(function* indeterminateMutation() {
    const failure = yield* Effect.flip(
      handleReconcileCounterpartyAccessGrantAuthorizationMutation(request, context).pipe(
        Effect.provideService(AccessAuthorizationMutationReconciliation, {
          reconcile: () => Effect.succeed({ outcome: 'INDETERMINATE' }),
        }),
        Effect.provideService(OutboxWorkerLegalEntityScopeFanout, scopeFanout),
      ),
    );
    expect(callbackCompleted.value).toBe(true);
    expect(failure.code).toBe('RECONCILIATION_INDETERMINATE');
  });
});

it.effect('rejects cross-Tenant request references before reconciliation', () => {
  let reconciliationCalls = 0;
  const foreignRequest = {
    ...request,
    counterpartyRef: { ...counterpartyRef, tenantId: otherTenantId },
  };
  return Effect.gen(function* crossTenantRequest() {
    const failure = yield* Effect.flip(
      runGrant(
        {
          reconcile: () => {
            reconciliationCalls += 1;
            return Effect.succeed({ outcome: 'INDETERMINATE' });
          },
        },
        publisher(),
        foreignRequest,
      ),
    );
    expect(failure.code).toBe('CROSS_TENANT_REQUEST');
    expect(reconciliationCalls).toBe(0);
  });
});

it.effect('supports an aggregate claim trigger with no fabricated grant mutation identity', () => {
  const claimRequest = {
    catalogVersion: '1',
    counterpartyRef,
    invitationRef,
    legalEntityId,
    mutationId,
    operation: 'claim',
    permissionMutations: [],
    schemaVersion: '1',
    scope,
  } as const;
  const invitation = {
    catalogVersion: '1',
    claimant: recipient,
    claimProofVersion: 'commerce-invitation-proof.v1',
    counterpartyRef,
    createdAt: '2026-09-09T09:00:00.000Z',
    deliveryMethod: 'VERIFIED_CONTACT_POINT',
    deliveryReference: 'contact-point-ref',
    expiresAt: '2026-09-10T09:00:00.000Z',
    grantProgress: [{ grantRef, permission: 'counterparty.purchase.prepare', state: 'ACTIVE' }],
    intendedPermissions: ['counterparty.purchase.prepare'],
    invitationRef,
    invitedBy: actor,
    reason: 'Onboard buyer',
    revision: 3,
    scope,
    state: 'CLAIMED',
  } as const;
  const attestation = {
    attestationReference: 'attestation-ref',
    claimant: recipient,
    counterpartyRef,
    invitationRef,
    inviterAuthority: {
      decision: 'ALLOWED',
      inviter: actor,
      permission: 'counterparty.access.manage',
      scope,
    },
    proofVersion: 'commerce-invitation-proof.v1',
    state: 'VERIFIED_AND_CONSUMED',
    verifiedAt: '2026-09-09T09:30:00.000Z',
  } as const;
  let published: OutboxWorkerCompletionInput<unknown> | undefined;
  const claimContext = {
    ...context,
    topic: 'commerce.customer-context.counterparty-access-invitation-claim-authorization-mutation-requested.v1',
    workerKey: 'commerce.customer-context.reconcile-counterparty-access-invitation-claim-authorization-mutation',
  };
  return Effect.gen(function* aggregateClaim() {
    yield* handleReconcileCounterpartyAccessInvitationClaimAuthorizationMutation(claimRequest, claimContext).pipe(
      Effect.provideService(AccessAuthorizationMutationReconciliation, {
        reconcile: () =>
          Effect.succeed({
            outcome: 'ALREADY_FINAL',
            terminal: {
              attestation,
              completionId: mutationId,
              invitation,
              kind: 'INVITATION_CLAIM',
              occurredAt,
              sourceActionInvocationId: actionInvocationId,
            },
          }),
      }),
      Effect.provideService(
        OutboxWorkerLegalEntityScopeFanout,
        fanout(
          publisher((input) => {
            published = input;
          }),
        ),
      ),
    );
    expect(published?.payloadJson).toMatchObject({ claimedBy: recipient, invitationRef });
  });
});

it('registers four exact owner-local background workers', () => {
  const workers = [
    reconcileCounterpartyAccessGrantAuthorizationMutationWorker,
    reconcileCounterpartyAccessRevokeAuthorizationMutationWorker,
    reconcileCounterpartyAccessAdministratorBootstrapAuthorizationMutationWorker,
    reconcileCounterpartyAccessInvitationClaimAuthorizationMutationWorker,
  ];
  expect(workers).toHaveLength(4);
  expect(
    workers.every(
      ({ descriptor }) =>
        descriptor.consumerModuleKey === 'commerce.customer-context' &&
        descriptor.entrypoint.authorization.kind === 'owner_local_background' &&
        descriptor.entrypoint.role === 'worker',
    ),
  ).toBe(true);
  expect(new Set(workers.map(({ descriptor }) => descriptor.topic)).size).toBe(4);
});
