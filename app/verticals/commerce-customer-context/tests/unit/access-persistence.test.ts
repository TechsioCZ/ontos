import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime';
import { ScopedRoutineInvocationError } from '@app/core-runtime';
import { readFile } from 'node:fs/promises';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CounterpartyAccessContractViolation } from '../../shared/domain/access-port.ts';
import type { CounterpartyAccessDomainError } from '../../shared/domain/access-port.ts';
import type { VerifiedInvitationClaimAttestation } from '../../shared/domain/invitation-contract.ts';
import {
  accessAuthorizationMutationReconciliationForWorker,
  accessAuthorizationMutationReconciliationForTransaction,
  accessAuthorizationReconcilerForTransaction,
  counterpartyAccessPortForTransaction,
  currentOwnerAccessForTransaction,
  lockingCurrentOwnerAccessForTransaction,
} from '../../src/persistence/access-persistence.ts';
import { CounterpartyAccessInvitationClaimAuthorizationMutationRequestedPayloadSchema } from '../../shared/domain/access-authorization-mutation.ts';
import type {
  CounterpartyAccessScopedRoutineInvoker,
  CounterpartyAccessPersistenceContext,
} from '../../src/persistence/access-persistence.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const actorId = '40000000-0000-4000-8000-000000000001';
const recipientId = '50000000-0000-4000-8000-000000000001';
const invitationId = '60000000-0000-4000-8000-000000000001';
const grantId = '70000000-0000-4000-8000-000000000001';
const invocationId = '80000000-0000-4000-8000-000000000001';
const mutationId = '81000000-0000-4000-8000-000000000001';
const claimMutationId = '82000000-0000-4000-8000-000000000001';
const compensationMutationId = '83000000-0000-4000-8000-000000000001';
const counterpartyId = 'counterparty-one';

const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: counterpartyId,
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const actor = { principalId: actorId, tenantId } as const;
const recipient = { principalId: recipientId, tenantId } as const;
const scope = Object.freeze({
  authContextRef: 'better-auth-session:test',
  authMethod: 'session',
  correlationId: 'correlation-one',
  legalEntityId,
  principalId: actorId,
  tenantId,
} as const);

// oxlint-disable-next-line effect-native/no-literal-union-type-alias -- This test-only row-fixture vocabulary mirrors private persistence output and has no runtime parsing boundary.
type GrantState = 'ACTIVE' | 'PENDING_GRANT' | 'PENDING_REVOKE' | 'RECONCILIATION_REQUIRED' | 'REVOKED';
// oxlint-disable-next-line effect-native/no-literal-union-type-alias -- This test-only routine-result vocabulary drives fixture typing and has no runtime parsing boundary.
type GrantOperationOutcome =
  | 'ALREADY_ACTIVE'
  | 'ALREADY_REVOKED'
  | 'CONFLICT'
  | 'LAST_ADMIN_PROTECTED'
  | 'PENDING_GRANT'
  | 'PENDING_REVOKE';
// oxlint-disable-next-line effect-native/no-literal-union-type-alias -- This test-only mutation marker includes null fixture state and has no runtime parsing boundary.
type GrantMutationOperation = 'grant' | 'revoke' | null;

const grantRowFixture = Object.freeze({
  counterparty_resource_id: counterpartyId,
  grant_id: grantId,
  granted_at: '2026-09-09T09:00:00.000Z',
  granted_by: actorId,
  permission_code: 'counterparty.access.manage',
  principal_id: recipientId,
  reason: 'Access administration',
  storefront_resource_id: null,
});

const grantMutationOperation = (operationOutcome?: GrantOperationOutcome): GrantMutationOperation => {
  let mutationOperation: 'grant' | 'revoke' | null = null;
  if (operationOutcome === 'PENDING_GRANT') {
    mutationOperation = 'grant';
  } else if (operationOutcome === 'PENDING_REVOKE') {
    mutationOperation = 'revoke';
  }
  return mutationOperation;
};

const buildGrantRow = (state: GrantState, mutationOperation: GrantMutationOperation) => ({
  ...grantRowFixture,
  action_invocation_id: mutationOperation === null ? null : invocationId,
  mutation_id: mutationOperation === null ? null : mutationId,
  mutation_operation: mutationOperation,
  mutation_staged: mutationOperation === null ? null : true,
  revision: state === 'PENDING_GRANT' || state === 'PENDING_REVOKE' ? 1 : 2,
  revoked_at: state === 'REVOKED' ? '2026-09-09T09:01:00.000Z' : null,
  revoked_by: state === 'REVOKED' ? actorId : null,
  state,
});

const grantRow = (state: GrantState, operationOutcome?: GrantOperationOutcome) => {
  const row = buildGrantRow(state, grantMutationOperation(operationOutcome));
  return operationOutcome === undefined ? row : { ...row, operation_outcome: operationOutcome };
};

type RoutineHandler = (routineKey: string, values: readonly unknown[]) => readonly object[];

const invokerWith = (handler: RoutineHandler): CounterpartyAccessScopedRoutineInvoker => ({
  invoke: (routine, values) =>
    Effect.sync(() => handler(routine.routineKey, values)).pipe(
      Effect.flatMap((rows) =>
        // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach is an Effect combinator; its second argument is the element effect, not Array thisArg.
        Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(routine.resultSchema)(row)),
      ),
      Effect.mapError(
        () =>
          new ScopedRoutineInvocationError({
            code: 'scoped_routine_result_invalid',
            constraint: Option.none(),
            ownerModuleKey: routine.ownerModuleKey,
            postgresCode: Option.none(),
            reason: 'The test routine row did not satisfy its declared schema',
            routineKey: routine.routineKey,
          }),
      ),
    ),
});

const attestation = Object.freeze({
  attestationReference: 'safe-attestation-one',
  claimant: recipient,
  counterpartyRef,
  invitationRef: {
    moduleId: 'commerce.customer-context',
    resourceId: invitationId,
    resourceType: 'commerce.customer-context.counterparty-access-invitation',
    tenantId,
  },
  inviterAuthority: {
    decision: 'ALLOWED',
    inviter: actor,
    permission: 'counterparty.access.manage',
    scope: { kind: 'counterparty' },
  },
  proofVersion: 'commerce-invitation-proof.v1',
  state: 'VERIFIED_AND_CONSUMED',
  verifiedAt: '2026-09-09T09:00:30.000Z',
} as const satisfies VerifiedInvitationClaimAttestation);

const dependenciesWith = (
  transaction: CounterpartyAccessScopedRoutineInvoker,
  overrides: Partial<CounterpartyAccessPersistenceContext> = {},
): CounterpartyAccessPersistenceContext => ({
  claimAuthority: { verifyAndConsume: () => Effect.succeed(attestation) },
  contextAccess: {
    businessPermissions: ({ targets }) =>
      Effect.succeed(targets.map(({ permission }) => ({ decision: 'allowed', key: permission }))),
  },
  currentOwnerAccess: () => Effect.succeed('ALLOWED' as const),
  eligibility: {
    resolve: (principal) => Effect.succeed({ decision: 'eligible', principal, reason: 'active' }),
  },
  proofLifecycle: {
    issueAndStageDelivery: () =>
      Effect.succeed({
        proofReference: 'safe-proof-reference',
        proofVersion: 'commerce-invitation-proof.v1',
        state: 'DELIVERY_STAGED',
      }),
    rotateAndStageDelivery: () =>
      Effect.succeed({
        proofReference: 'safe-proof-reference',
        proofVersion: 'commerce-invitation-proof.v1',
        state: 'DELIVERY_STAGED',
      }),
  },
  scope,
  transaction,
  ...overrides,
});

const allowedOwnerAccessForWorker: typeof currentOwnerAccessForTransaction = () => () =>
  Effect.succeed('ALLOWED' as const);

const grantInput = {
  actionInvocationId: invocationId,
  actor,
  counterpartyRef,
  legalEntityId,
  permission: 'counterparty.access.manage',
  reason: 'Access administration',
  recipient,
  scope: { kind: 'counterparty' },
} as const;

const invitationRow = (state: 'CLAIMING' | 'CLAIMED') => {
  const row = {
    claimed_at: state === 'CLAIMED' ? '2026-09-09T09:01:00.000Z' : null,
    claimed_by_principal_id: recipientId,
    counterparty_resource_id: counterpartyId,
    created_at: '2026-09-09T09:00:00.000Z',
    delivery_method: 'VERIFIED_CONTACT_POINT',
    delivery_reference: 'safe-delivery-reference',
    expires_at: '2026-09-10T09:00:00.000Z',
    grant_progress: [
      state === 'CLAIMED'
        ? {
            grantRef: {
              moduleId: 'commerce.customer-context',
              resourceId: grantId,
              resourceType: 'commerce.customer-context.counterparty-commerce-access-grant',
              tenantId,
            },
            permission: 'counterparty.access.manage',
            state: 'ACTIVE',
          }
        : { permission: 'counterparty.access.manage', state: 'PENDING_GRANT' },
    ],
    invitation_id: invitationId,
    invited_by: actorId,
    mutation_id: claimMutationId,
    mutation_staged: state === 'CLAIMING',
    reason: 'Invite administrator',
    requested_permission_codes: ['counterparty.access.manage'],
    revision: state === 'CLAIMING' ? 2 : 3,
    state,
    storefront_resource_id: null,
  };
  return state === 'CLAIMING' ? { ...row, operation_outcome: 'CLAIMING' } : row;
};

const pendingInvitationRow = (operationOutcome: 'ALREADY_PENDING' | 'ALREADY_SENT' | 'CREATED' | 'RESENT') => ({
  claimed_at: null,
  claimed_by_principal_id: null,
  counterparty_resource_id: counterpartyId,
  created_at: '2026-09-09T09:00:00.000Z',
  delivery_method: 'VERIFIED_CONTACT_POINT',
  delivery_reference: 'safe-delivery-reference',
  expires_at: '2026-09-10T09:00:00.000Z',
  grant_progress: [],
  invitation_id: invitationId,
  invited_by: actorId,
  mutation_id: claimMutationId,
  mutation_staged: operationOutcome === 'RESENT',
  operation_outcome: operationOutcome,
  reason: 'Invite administrator',
  requested_permission_codes: ['counterparty.access.manage'],
  revision: operationOutcome === 'RESENT' || operationOutcome === 'ALREADY_SENT' ? 2 : 1,
  state: 'PENDING',
  storefront_resource_id: null,
});

const claimInput = {
  actionInvocationId: invocationId,
  actor,
  claimant: recipient,
  claimProofReference: 'secure-vault-proof-one',
  counterpartyRef,
  expectedRevision: 1,
  invitationRef: attestation.invitationRef,
  legalEntityId,
  reason: 'Accept invitation',
  scope: { kind: 'counterparty' },
} as const;

const claimReconciliationRow = (state: 'CLAIMED' | 'RECONCILIATION_REQUIRED') => ({
  attestation_reference: attestation.attestationReference,
  claim_mutation_id: claimMutationId,
  claim_subject_principal_id: null,
  claimed_at: state === 'CLAIMED' ? '2026-09-09T09:02:00.000Z' : null,
  claimed_by_principal_id: recipientId,
  counterparty_resource_id: counterpartyId,
  created_at: '2026-09-09T09:00:00.000Z',
  delivery_method: 'VERIFIED_CONTACT_POINT',
  delivery_reference: 'safe-delivery-reference',
  expires_at: '2026-09-10T09:00:00.000Z',
  grant_progress: [
    state === 'CLAIMED'
      ? {
          grantRef: {
            moduleId: 'commerce.customer-context',
            resourceId: grantId,
            resourceType: 'commerce.customer-context.counterparty-commerce-access-grant',
            tenantId,
          },
          permission: 'counterparty.access.manage',
          state: 'ACTIVE',
        }
      : { permission: 'counterparty.access.manage', state: 'PENDING_GRANT' },
  ],
  invitation_id: invitationId,
  invited_by: actorId,
  reason: 'Invite administrator',
  requested_permission_codes: ['counterparty.access.manage'],
  revision: state === 'CLAIMED' ? 4 : 3,
  source_action_invocation_id: invocationId,
  state,
  storefront_resource_id: null,
  verified_at: attestation.verifiedAt,
});

const claimReconciliationRequest = Schema.decodeUnknownSync(
  CounterpartyAccessInvitationClaimAuthorizationMutationRequestedPayloadSchema,
)({
  catalogVersion: '1',
  counterpartyRef,
  invitationRef: attestation.invitationRef,
  legalEntityId,
  mutationId: claimMutationId,
  operation: 'claim',
  permissionMutations: [],
  schemaVersion: '1',
  scope: { kind: 'counterparty' },
});

const workerScope = (routineInvoker: CounterpartyAccessScopedRoutineInvoker) =>
  ({
    completionPublisher: {
      publish: () => Effect.succeed({ domainEventId: mutationId, outcome: 'PUBLISHED' as const }),
    },
    legalEntityId,
    routineInvoker,
    tenantId,
  }) satisfies OutboxWorkerLegalEntityScope;

it.effect('commits a durable grant intent without performing the external relationship write', () =>
  Effect.gen(function* grantAccess() {
    const calls: string[] = [];
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith((routineKey, values) => {
          calls.push(routineKey);
          return routineKey === 'counterparty-access.begin-grant'
            ? [grantRow('PENDING_GRANT', 'PENDING_GRANT')]
            : [grantRow(values[3] === 'ACTIVE' ? 'ACTIVE' : 'RECONCILIATION_REQUIRED')];
        }),
      ),
    );

    const result = yield* port.grant(grantInput);
    expect(result.outcome).toBe('RECONCILIATION_REQUIRED');
    expect(result.grant.state).toBe('RECONCILIATION_REQUIRED');
    if (result.outcome === 'RECONCILIATION_REQUIRED') {
      expect(result.reconciliation).toEqual({
        mutationId,
        operation: 'grant',
        staged: true,
      });
    }
    expect(calls).toEqual(['counterparty-access.begin-grant', 'counterparty-access.transition-grant']);
  }),
);

it.effect('denies an allowed Core relation while the owner revoke is still pending', () =>
  Effect.gen(function* denyDuringPendingRevoke() {
    const transaction = invokerWith((routineKey) =>
      routineKey === 'counterparty-access.list-grants' ? [grantRow('PENDING_REVOKE', 'PENDING_REVOKE')] : [],
    );
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(transaction, {
        currentOwnerAccess: currentOwnerAccessForTransaction(transaction, scope),
      }),
    );

    const decision = yield* port.check({
      counterpartyRef,
      permission: 'counterparty.access.manage',
      principal: recipient,
      scope: { kind: 'counterparty' },
    });
    expect(decision).toBe('DENIED');
  }),
);

it.effect('returns unavailable when owner access is indeterminate during reconciliation', () =>
  Effect.gen(function* unavailableDuringReconciliation() {
    const transaction = invokerWith((routineKey) =>
      routineKey === 'counterparty-access.list-grants' ? [grantRow('RECONCILIATION_REQUIRED')] : [],
    );
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(transaction, {
        currentOwnerAccess: currentOwnerAccessForTransaction(transaction, scope),
      }),
    );

    const decision = yield* port.check({
      counterpartyRef,
      permission: 'counterparty.access.manage',
      principal: recipient,
      scope: { kind: 'counterparty' },
    });
    expect(decision).toBe('UNAVAILABLE');
  }),
);

it.effect('fails closed when the owner access reader is omitted', () =>
  Effect.gen(function* missingOwnerReader() {
    const transaction = invokerWith(() => [grantRow('ACTIVE')]);
    const dependencies = dependenciesWith(transaction);
    const { currentOwnerAccess: _omittedOwnerReader, ...withoutOwnerReader } = dependencies;
    const decision = yield* counterpartyAccessPortForTransaction(withoutOwnerReader).check({
      counterpartyRef,
      permission: 'counterparty.access.manage',
      principal: recipient,
      scope: { kind: 'counterparty' },
    });
    expect(decision).toBe('UNAVAILABLE');
  }),
);

it.effect('lets a broad active owner grant cover a narrower scope despite stale rows', () =>
  Effect.gen(function* broadActiveOwnerGrant() {
    const transaction = invokerWith((routineKey) =>
      routineKey === 'counterparty-access.list-grants'
        ? [
            grantRow('ACTIVE'),
            {
              ...grantRow('PENDING_REVOKE', 'PENDING_REVOKE'),
              storefront_resource_id: 'storefront-one',
            },
          ]
        : [],
    );
    const reader = currentOwnerAccessForTransaction(transaction, scope);

    const decision = yield* reader({
      counterpartyRef,
      legalEntityId,
      permission: 'counterparty.access.manage',
      principal: recipient,
      scope: { kind: 'storefront', storefrontKey: 'storefront-one' },
    });

    expect(decision).toBe('ALLOWED');
  }),
);

it.effect('fails closed when a pending row is missing its durable mutation identity', () =>
  Effect.gen(function* rejectMissingMutationIdentity() {
    const transitioned: unknown[] = [];
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith((routineKey, values) => {
          if (routineKey === 'counterparty-access.begin-grant') {
            return [
              {
                ...grantRow('PENDING_GRANT', 'PENDING_GRANT'),
                mutation_id: null,
                mutation_operation: null,
              },
            ];
          }
          transitioned.push(...values);
          return [grantRow('RECONCILIATION_REQUIRED')];
        }),
      ),
    );

    yield* Effect.flip(port.grant(grantInput));
    expect(transitioned).toEqual([]);
  }),
);

it.effect('returns last-admin protection and idempotent active outcomes without staging another intent', () =>
  Effect.gen(function* protectLastAdministrator() {
    const active = counterpartyAccessPortForTransaction(
      dependenciesWith(invokerWith(() => [grantRow('ACTIVE', 'ALREADY_ACTIVE')])),
    );
    const protectedPort = counterpartyAccessPortForTransaction(
      dependenciesWith(invokerWith(() => [grantRow('ACTIVE', 'LAST_ADMIN_PROTECTED')])),
    );

    expect((yield* active.grant(grantInput)).outcome).toBe('ALREADY_ACTIVE');
    expect((yield* protectedPort.revoke(grantInput)).outcome).toBe('LAST_ADMIN_PROTECTED');
  }),
);

it.effect('completes pending revoke and repairs indeterminate relationship mutations', () =>
  Effect.gen(function* revokeAndReconcile() {
    const recoveredStorefronts: (string | undefined)[] = [];
    const transaction = invokerWith((routineKey, values) => {
      if (routineKey === 'counterparty-access.begin-revoke') {
        return [grantRow('PENDING_REVOKE', 'PENDING_REVOKE')];
      }
      if (routineKey === 'counterparty-access.list-reconciliation') {
        return [
          {
            ...grantRow('RECONCILIATION_REQUIRED'),
            action_invocation_id: invocationId,
            mutation_id: mutationId,
            recovery_operation: 'grant',
            storefront_resource_id: 'persisted-storefront',
          },
        ];
      }
      return [grantRow(values[3] === 'REVOKED' ? 'REVOKED' : 'ACTIVE')];
    });
    const dependencies = dependenciesWith(transaction);
    const revoked = yield* counterpartyAccessPortForTransaction(dependencies).revoke(grantInput);
    const summary = yield* accessAuthorizationReconcilerForTransaction(dependencies, {
      mutate: (input) =>
        Effect.sync(() => {
          recoveredStorefronts.push(input.trustedStorefrontId);
        }),
    }).reconcile({ limit: 10, tenantId });
    expect(revoked.outcome).toBe('RECONCILIATION_REQUIRED');
    if (revoked.outcome === 'RECONCILIATION_REQUIRED') {
      expect(revoked.reconciliation).toEqual({
        mutationId,
        operation: 'revoke',
        staged: true,
      });
    }
    expect(summary).toEqual({ examined: 1, repaired: 1, stillIndeterminate: 0 });
    expect(recoveredStorefronts).toContain('persisted-storefront');
  }),
);

it.effect('reconciles one exact committed mutation and returns terminal grant evidence', () =>
  Effect.gen(function* reconcileOneCommittedMutation() {
    let relationshipWrites = 0;
    let exactReads = 0;
    const transaction = invokerWith((routineKey, values) => {
      if (routineKey === 'counterparty-access.read-reconciliation') {
        exactReads += 1;
        return [
          {
            ...grantRow(exactReads === 1 ? 'RECONCILIATION_REQUIRED' : 'ACTIVE'),
            action_invocation_id: invocationId,
            mutation_id: mutationId,
            recovery_operation: 'grant',
          },
        ];
      }
      expect(values).toEqual([grantId, mutationId, 'grant', 'ACTIVE']);
      return [grantRow('ACTIVE')];
    });
    const result = yield* accessAuthorizationMutationReconciliationForTransaction(dependenciesWith(transaction), {
      mutate: () =>
        Effect.sync(() => {
          relationshipWrites += 1;
        }),
    }).reconcileOne({
      counterpartyResourceId: counterpartyId,
      grantId,
      mutationId,
      operation: 'grant',
    });

    expect(result.outcome).toBe('FINALIZED');
    expect(result.grant.state).toBe('ACTIVE');
    expect(result.sourceActionInvocationId).toBe(invocationId);
    expect(result.occurredAt.toISOString()).toBe('2026-09-09T09:00:00.000Z');
    expect(relationshipWrites).toBe(1);
    expect(exactReads).toBe(2);
  }),
);

it.effect('commits newly staged invitation successors before any relationship mutation', () =>
  Effect.gen(function* stageClaimSuccessorBeforeMutation() {
    let relationshipWrites = 0;
    let finalizations = 0;
    const transaction = invokerWith((routineKey) => {
      if (routineKey === 'counterparty-access.read-invitation-claim-reconciliation') {
        return [claimReconciliationRow('RECONCILIATION_REQUIRED')];
      }
      if (routineKey === 'counterparty-access.stage-invitation-claim-grants') {
        return [
          {
            ...grantRow('RECONCILIATION_REQUIRED'),
            action_invocation_id: invocationId,
            mutation_id: mutationId,
            mutation_staged: true,
            recovery_operation: 'grant',
          },
        ];
      }
      finalizations += 1;
      return [];
    });
    const service = accessAuthorizationMutationReconciliationForWorker(
      dependenciesWith(transaction).contextAccess,
      {
        mutate: () =>
          Effect.sync(() => {
            relationshipWrites += 1;
          }),
      },
      allowedOwnerAccessForWorker,
    );
    const result = yield* service.reconcile(workerScope(transaction), claimReconciliationRequest);

    expect(result).toEqual({ outcome: 'INDETERMINATE' });
    expect(relationshipWrites).toBe(0);
    expect(finalizations).toBe(0);
  }),
);

it.effect('reconciles durable invitation grants and returns replay-safe terminal claim evidence', () =>
  Effect.gen(function* reconcileInvitationClaim() {
    let relationshipWrites = 0;
    const transaction = invokerWith((routineKey, values) => {
      if (routineKey === 'counterparty-access.read-invitation-claim-reconciliation') {
        return [claimReconciliationRow('RECONCILIATION_REQUIRED')];
      }
      if (routineKey === 'counterparty-access.stage-invitation-claim-grants') {
        return [
          {
            ...grantRow('RECONCILIATION_REQUIRED'),
            action_invocation_id: invocationId,
            mutation_id: mutationId,
            mutation_staged: false,
            recovery_operation: 'grant',
          },
        ];
      }
      if (routineKey === 'counterparty-access.transition-grant') {
        expect(values).toEqual([grantId, mutationId, 'grant', 'ACTIVE']);
        return [grantRow('ACTIVE')];
      }
      if (routineKey === 'counterparty-access.finalize-reconciled-invitation') {
        return [{ ...claimReconciliationRow('CLAIMED'), operation_outcome: 'CLAIMED' }];
      }
      return [];
    });
    const service = accessAuthorizationMutationReconciliationForWorker(
      dependenciesWith(transaction).contextAccess,
      {
        mutate: () =>
          Effect.sync(() => {
            relationshipWrites += 1;
          }),
      },
      allowedOwnerAccessForWorker,
    );
    const result = yield* service.reconcile(workerScope(transaction), claimReconciliationRequest);

    expect(result.outcome).toBe('FINALIZED');
    if (result.outcome === 'FINALIZED' || result.outcome === 'ALREADY_FINAL') {
      expect(result.terminal.kind).toBe('INVITATION_CLAIM');
      expect(result.terminal.completionId).toBe(claimMutationId);
      expect(result.terminal.sourceActionInvocationId).toBe(invocationId);
      expect(result.terminal.occurredAt.toISOString()).toBe('2026-09-09T09:02:00.000Z');
    }
    expect(relationshipWrites).toBe(1);
  }),
);

it.effect('durably compensates claim-created tuples when inviter authority is lost', () =>
  Effect.gen(function* compensateLostInviterAuthority() {
    const relationshipOperations: string[] = [];
    let authorityChecks = 0;
    let compensationStages = 0;
    const transaction = invokerWith((routineKey, values) => {
      if (routineKey === 'counterparty-access.read-invitation-claim-reconciliation') {
        return [claimReconciliationRow('RECONCILIATION_REQUIRED')];
      }
      if (routineKey === 'counterparty-access.stage-invitation-claim-grants') {
        if (values[1] === true) {
          compensationStages += 1;
          return [
            {
              ...grantRow('RECONCILIATION_REQUIRED'),
              action_invocation_id: invocationId,
              mutation_id: compensationMutationId,
              mutation_staged: compensationStages === 1,
              recovery_operation: 'revoke',
            },
          ];
        }
        return [
          {
            ...grantRow('RECONCILIATION_REQUIRED'),
            action_invocation_id: invocationId,
            mutation_id: mutationId,
            mutation_staged: false,
            recovery_operation: 'grant',
          },
        ];
      }
      if (routineKey === 'counterparty-access.transition-grant') {
        return [grantRow(values[2] === 'revoke' ? 'REVOKED' : 'ACTIVE')];
      }
      return [];
    });
    const contextAccess = {
      businessPermissions: ({
        targets,
      }: Parameters<NonNullable<CounterpartyAccessPersistenceContext['contextAccess']['businessPermissions']>>[0]) => {
        authorityChecks += 1;
        const decision = authorityChecks === 1 ? ('allowed' as const) : ('denied' as const);
        return Effect.succeed(targets.map(({ permission }) => ({ decision, key: permission })));
      },
    };
    const service = accessAuthorizationMutationReconciliationForWorker(
      contextAccess,
      {
        mutate: ({ operation }) =>
          Effect.sync(() => {
            relationshipOperations.push(operation);
          }),
      },
      allowedOwnerAccessForWorker,
    );

    const first = yield* service.reconcile(workerScope(transaction), claimReconciliationRequest);
    expect(first).toEqual({ outcome: 'INDETERMINATE' });
    expect(relationshipOperations).toEqual(['grant']);

    const second = yield* service.reconcile(workerScope(transaction), claimReconciliationRequest);
    expect(second).toEqual({ outcome: 'INDETERMINATE' });
    expect(relationshipOperations).toEqual(['grant', 'revoke']);
  }),
);

it.effect('worker claim authority includes owner-local pending revoke state', () =>
  Effect.gen(function* workerOwnerOverlay() {
    let coreChecks = 0;
    const routineKeys: string[] = [];
    const transaction = invokerWith((routineKey) => {
      routineKeys.push(routineKey);
      if (routineKey === 'counterparty-access.read-invitation-claim-reconciliation') {
        return [claimReconciliationRow('RECONCILIATION_REQUIRED')];
      }
      if (
        routineKey === 'counterparty-access.list-grants' ||
        routineKey === 'counterparty-access.lock-grant-authority'
      ) {
        return [grantRow('PENDING_REVOKE', 'PENDING_REVOKE')];
      }
      if (routineKey === 'counterparty-access.stage-invitation-claim-grants') {
        return [];
      }
      if (routineKey === 'counterparty-access.mutate-invitation') {
        return [{ ...pendingInvitationRow('ALREADY_PENDING'), operation_outcome: 'CLAIM_REJECTED' }];
      }
      return [];
    });
    const contextAccess = {
      businessPermissions: () => {
        coreChecks += 1;
        return Effect.succeed([{ decision: 'allowed' as const, key: 'counterparty.access.manage' as const }]);
      },
    };
    const service = accessAuthorizationMutationReconciliationForWorker(
      contextAccess,
      { mutate: () => Effect.void },
      lockingCurrentOwnerAccessForTransaction,
    );

    const result = yield* service.reconcile(workerScope(transaction), claimReconciliationRequest);

    expect(result).toEqual({ outcome: 'COMPENSATED' });
    expect(coreChecks).toBe(0);
    expect(routineKeys).toContain('counterparty-access.lock-grant-authority');
  }),
);

it.effect('resets a claim when inviter authority is lost before any grant row exists', () =>
  Effect.gen(function* compensateClaimWithoutGrantRows() {
    let invitationResets = 0;
    let relationshipWrites = 0;
    const transaction = invokerWith((routineKey) => {
      if (routineKey === 'counterparty-access.read-invitation-claim-reconciliation') {
        return [claimReconciliationRow('RECONCILIATION_REQUIRED')];
      }
      if (routineKey === 'counterparty-access.stage-invitation-claim-grants') {
        return [];
      }
      if (routineKey === 'counterparty-access.mutate-invitation') {
        invitationResets += 1;
        return [
          {
            ...pendingInvitationRow('ALREADY_PENDING'),
            operation_outcome: 'CLAIM_REJECTED',
          },
        ];
      }
      return [];
    });
    const contextAccess = {
      businessPermissions: ({
        targets,
      }: Parameters<NonNullable<CounterpartyAccessPersistenceContext['contextAccess']['businessPermissions']>>[0]) =>
        Effect.succeed(targets.map(({ permission }) => ({ decision: 'denied' as const, key: permission }))),
    };
    const service = accessAuthorizationMutationReconciliationForWorker(
      contextAccess,
      {
        mutate: () =>
          Effect.sync(() => {
            relationshipWrites += 1;
          }),
      },
      allowedOwnerAccessForWorker,
    );

    const result = yield* service.reconcile(workerScope(transaction), claimReconciliationRequest);

    expect(result).toEqual({ outcome: 'COMPENSATED' });
    expect(invitationResets).toBe(1);
    expect(relationshipWrites).toBe(0);
  }),
);

it.effect('compensates a partial claim after revoke and converges once every tuple is removed', () =>
  Effect.gen(function* compensateRevokedPartialClaim() {
    let compensationStages = 0;
    const relationshipOperations: string[] = [];
    const revokedRoot = {
      ...claimReconciliationRow('RECONCILIATION_REQUIRED'),
      claim_subject_principal_id: recipientId,
      claimed_at: null,
      claimed_by_principal_id: null,
      grant_progress: [
        {
          grantRef: {
            moduleId: 'commerce.customer-context',
            resourceId: grantId,
            resourceType: 'commerce.customer-context.counterparty-commerce-access-grant',
            tenantId,
          },
          permission: 'counterparty.access.manage',
          state: 'ACTIVE',
        },
      ],
      revision: 4,
      state: 'REVOKED' as const,
    };
    const transaction = invokerWith((routineKey, values) => {
      if (routineKey === 'counterparty-access.read-invitation-claim-reconciliation') {
        return [revokedRoot];
      }
      if (routineKey === 'counterparty-access.stage-invitation-claim-grants') {
        if (values[1] !== true) {
          return [];
        }
        compensationStages += 1;
        return compensationStages === 1
          ? [
              {
                ...grantRow('RECONCILIATION_REQUIRED'),
                action_invocation_id: invocationId,
                mutation_id: compensationMutationId,
                mutation_staged: false,
                recovery_operation: 'revoke',
              },
            ]
          : [];
      }
      if (routineKey === 'counterparty-access.transition-grant') {
        return [grantRow('REVOKED')];
      }
      if (routineKey === 'counterparty-access.mutate-invitation') {
        return [
          {
            ...pendingInvitationRow('CREATED'),
            mutation_id: compensationMutationId,
            mutation_staged: false,
            operation_outcome: 'CLAIM_REJECTED',
          },
        ];
      }
      return [];
    });
    const service = accessAuthorizationMutationReconciliationForWorker(dependenciesWith(transaction).contextAccess, {
      mutate: ({ operation }) =>
        Effect.sync(() => {
          relationshipOperations.push(operation);
        }),
    });

    const first = yield* service.reconcile(workerScope(transaction), claimReconciliationRequest);
    expect(first).toEqual({ outcome: 'INDETERMINATE' });
    expect(relationshipOperations).toEqual(['revoke']);

    const second = yield* service.reconcile(workerScope(transaction), claimReconciliationRequest);
    expect(second).toEqual({ outcome: 'COMPENSATED' });
    expect(relationshipOperations).toEqual(['revoke']);
  }),
);

it.effect('rejects a mismatched invitation claim before staging or relationship mutation', () =>
  Effect.gen(function* rejectMismatchedClaim() {
    let calls = 0;
    const transaction = invokerWith(() => {
      calls += 1;
      return [
        {
          ...claimReconciliationRow('RECONCILIATION_REQUIRED'),
          counterparty_resource_id: 'different-counterparty',
        },
      ];
    });
    const service = accessAuthorizationMutationReconciliationForWorker(dependenciesWith(transaction).contextAccess, {
      mutate: () => Effect.die('must not mutate a mismatched claim'),
    });
    const failure = yield* Effect.flip(service.reconcile(workerScope(transaction), claimReconciliationRequest));

    expect(failure.code).toBe('RECONCILIATION_UNAVAILABLE');
    expect(calls).toBe(1);
  }),
);

it.effect('never promotes an untrusted storefront request into a trusted mutation target', () =>
  Effect.gen(function* rejectRequestStorefront() {
    let routineCalls = 0;
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith(() => {
          routineCalls += 1;
          return [];
        }),
      ),
    );
    const failure: CounterpartyAccessDomainError = yield* Effect.flip(
      port.grant({
        ...grantInput,
        scope: { kind: 'storefront', storefrontKey: 'request-storefront' },
      }),
    );
    expect(Schema.is(CounterpartyAccessContractViolation)(failure)).toBe(true);
    expect(routineCalls).toBe(0);
  }),
);

it.effect('stages an intent only for independently verified storefront scope', () =>
  Effect.gen(function* useTrustedStorefront() {
    const trustedStorefrontId = 'trusted-storefront';
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith((routineKey, values) =>
          routineKey === 'counterparty-access.begin-grant'
            ? [
                {
                  ...grantRow('PENDING_GRANT', 'PENDING_GRANT'),
                  storefront_resource_id: trustedStorefrontId,
                },
              ]
            : [
                {
                  ...grantRow(values[3] === 'ACTIVE' ? 'ACTIVE' : 'RECONCILIATION_REQUIRED'),
                  storefront_resource_id: trustedStorefrontId,
                },
              ],
        ),
        {
          trustedStorefrontId,
        },
      ),
    );

    const result = yield* port.grant({
      ...grantInput,
      scope: { kind: 'storefront', storefrontKey: trustedStorefrontId },
    });
    expect(result.outcome).toBe('RECONCILIATION_REQUIRED');
    expect(result.grant.scope).toEqual({
      kind: 'storefront',
      storefrontKey: trustedStorefrontId,
    });
  }),
);

it.effect('stages proof delivery only for material invitation create and resend transitions', () =>
  Effect.gen(function* stageInvitationProofs() {
    let createCalls = 0;
    let resendCalls = 0;
    const lifecycleOperations: string[] = [];
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith((routineKey) => {
          if (routineKey === 'counterparty-access.create-invitation') {
            createCalls += 1;
            return [pendingInvitationRow(createCalls === 1 ? 'CREATED' : 'ALREADY_PENDING')];
          }
          resendCalls += 1;
          return [pendingInvitationRow(resendCalls === 1 ? 'RESENT' : 'ALREADY_SENT')];
        }),
        {
          proofLifecycle: {
            issueAndStageDelivery: ({ invitationRef }) =>
              Effect.sync(() => {
                lifecycleOperations.push(`issue:${invitationRef.resourceId}`);
                return {
                  proofReference: 'safe-proof-reference',
                  proofVersion: 'commerce-invitation-proof.v1' as const,
                  state: 'DELIVERY_STAGED' as const,
                };
              }),
            rotateAndStageDelivery: ({ invitationRef }) =>
              Effect.sync(() => {
                lifecycleOperations.push(`rotate:${invitationRef.resourceId}`);
                return {
                  proofReference: 'safe-proof-reference',
                  proofVersion: 'commerce-invitation-proof.v1' as const,
                  state: 'DELIVERY_STAGED' as const,
                };
              }),
          },
        },
      ),
    );
    const createInput = {
      actionInvocationId: invocationId,
      actor,
      counterpartyRef,
      deliveryMethod: 'VERIFIED_CONTACT_POINT' as const,
      deliveryReference: 'safe-delivery-reference',
      expiresAt: '2026-09-10T09:00:00.000Z',
      intendedPermissions: ['counterparty.access.manage' as const],
      legalEntityId,
      reason: 'Invite administrator',
      scope: { kind: 'counterparty' as const },
    };
    const mutationInput = {
      actionInvocationId: invocationId,
      actor,
      counterpartyRef,
      expectedRevision: 1,
      invitationRef: attestation.invitationRef,
      legalEntityId,
      reason: 'Resend invitation',
      scope: { kind: 'counterparty' as const },
    };

    expect((yield* port.createInvitation(createInput)).outcome).toBe('CREATED');
    expect((yield* port.createInvitation(createInput)).outcome).toBe('ALREADY_PENDING');
    expect((yield* port.resendInvitation(mutationInput)).outcome).toBe('RESENT');
    expect((yield* port.resendInvitation(mutationInput)).outcome).toBe('ALREADY_SENT');
    expect(lifecycleOperations).toEqual([`issue:${invitationId}`, `rotate:${invitationId}`]);
  }),
);

it.effect('binds one consumed attestation to the exact claim and persists only its safe reference', () =>
  Effect.gen(function* claimInvitation() {
    const invitationMutations: unknown[][] = [];
    let authorityChecks = 0;
    let inviterChecks = 0;
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith((routineKey, values) => {
          if (routineKey === 'counterparty-access.mutate-invitation') {
            invitationMutations.push([...values]);
            return values[4] === 'BEGIN_CLAIM'
              ? [invitationRow('CLAIMING')]
              : [
                  {
                    ...invitationRow('CLAIMING'),
                    grant_progress: [
                      {
                        grantRef: {
                          moduleId: 'commerce.customer-context',
                          resourceId: grantId,
                          resourceType: 'commerce.customer-context.counterparty-commerce-access-grant',
                          tenantId,
                        },
                        permission: 'counterparty.access.manage',
                        state: 'RECONCILIATION_REQUIRED',
                      },
                    ],
                    operation_outcome: 'RECONCILIATION_REQUIRED',
                    revision: 3,
                    state: 'RECONCILIATION_REQUIRED',
                  },
                ];
          }
          if (routineKey === 'counterparty-access.begin-grant') {
            return [grantRow('PENDING_GRANT', 'PENDING_GRANT')];
          }
          return [grantRow('ACTIVE')];
        }),
        {
          claimAuthority: {
            verifyAndConsume: () =>
              Effect.sync(() => {
                authorityChecks += 1;
                return attestation;
              }),
          },
          contextAccess: {
            businessPermissions: ({ targets }) =>
              Effect.sync(() => {
                inviterChecks += 1;
                return targets.map(({ permission }) => ({
                  decision: 'allowed' as const,
                  key: permission,
                }));
              }),
          },
        },
      ),
    );

    const result = yield* port.claimInvitation(claimInput);
    expect(result.outcome).toBe('RECONCILIATION_REQUIRED');
    if (result.outcome !== 'RECONCILIATION_REQUIRED') {
      return;
    }
    expect(result.attestation).toEqual(attestation);
    expect(result.reconciliation).toEqual({
      mutationId: claimMutationId,
      operation: 'claim',
      permissionMutations: [
        {
          grantRef: {
            moduleId: 'commerce.customer-context',
            resourceId: grantId,
            resourceType: 'commerce.customer-context.counterparty-commerce-access-grant',
            tenantId,
          },
          mutationId,
          operation: 'grant',
          permission: 'counterparty.access.manage',
          staged: true,
        },
      ],
      staged: true,
    });
    expect(authorityChecks).toBe(1);
    expect(inviterChecks).toBe(2);
    expect(invitationMutations[0]).toContain(claimInput.claimProofReference);
    expect(invitationMutations[1]).toContain(attestation.attestationReference);
  }),
);

it.effect('rejects a verifier attestation for a different invitation before any grant', () =>
  Effect.gen(function* rejectMismatchedAttestation() {
    let grants = 0;
    const mismatched = {
      ...attestation,
      invitationRef: { ...attestation.invitationRef, resourceId: 'different-invitation' },
    } satisfies VerifiedInvitationClaimAttestation;
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith((routineKey) => {
          if (routineKey === 'counterparty-access.begin-grant') {
            grants += 1;
          }
          return [invitationRow('CLAIMING')];
        }),
        { claimAuthority: { verifyAndConsume: () => Effect.succeed(mismatched) } },
      ),
    );

    const failure = yield* Effect.flip(port.claimInvitation(claimInput));
    expect(Schema.is(CounterpartyAccessContractViolation)(failure)).toBe(true);
    expect(grants).toBe(0);
  }),
);

it.effect('commits proof rejection evidence while restoring the invitation to pending', () =>
  Effect.gen(function* persistProofRejection() {
    const invitationOperations: unknown[] = [];
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith((routineKey, values) => {
          if (routineKey !== 'counterparty-access.mutate-invitation') {
            return [];
          }
          invitationOperations.push(values[4]);
          return values[4] === 'BEGIN_CLAIM'
            ? [invitationRow('CLAIMING')]
            : [
                {
                  ...pendingInvitationRow('ALREADY_PENDING'),
                  mutation_id: claimMutationId,
                  mutation_staged: false,
                  operation_outcome: 'CLAIM_REJECTED',
                  revision: 3,
                },
              ];
        }),
        {
          claimAuthority: {
            verifyAndConsume: () =>
              Effect.fail(
                new CounterpartyAccessContractViolation({
                  code: 'invitation_claim_proof_invalid',
                  reason: 'The invitation claim proof is invalid',
                }),
              ),
          },
        },
      ),
    );

    const result = yield* port.claimInvitation(claimInput);
    expect(result.outcome).toBe('REJECTED');
    if (result.outcome === 'REJECTED') {
      expect(result.rejection).toBe('INVALID_PROOF');
      expect(result.invitation.state).toBe('PENDING');
    }
    expect(invitationOperations).toEqual(['BEGIN_CLAIM', 'REJECT_CLAIM']);
  }),
);

it.effect('does not expose an already-claimed invitation to a different claimant', () =>
  Effect.gen(function* rejectDifferentClaimantReplay() {
    let authorityChecks = 0;
    const differentClaimantId = '90000000-0000-4000-8000-000000000001';
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith(() => [
          {
            ...invitationRow('CLAIMED'),
            claimed_by_principal_id: differentClaimantId,
            operation_outcome: 'ALREADY_CLAIMED',
          },
        ]),
        {
          claimAuthority: {
            verifyAndConsume: () =>
              Effect.sync(() => {
                authorityChecks += 1;
                return attestation;
              }),
          },
        },
      ),
    );

    const failure = yield* Effect.flip(port.claimInvitation(claimInput));
    expect(Schema.is(CounterpartyAccessContractViolation)(failure)).toBe(true);
    expect(failure.code).toBe('invitation_claimant_mismatch');
    expect(authorityChecks).toBe(0);
  }),
);

it.effect('preserves a recoverable invitation when an intended grant conflicts', () =>
  Effect.gen(function* reconcileConflictingClaimGrant() {
    const invitationOperations: unknown[] = [];
    const reconciliationRow = {
      ...invitationRow('CLAIMING'),
      grant_progress: [
        {
          grantRef: {
            moduleId: 'commerce.customer-context',
            resourceId: grantId,
            resourceType: 'commerce.customer-context.counterparty-commerce-access-grant',
            tenantId,
          },
          permission: 'counterparty.access.manage',
          state: 'RECONCILIATION_REQUIRED',
        },
      ],
      operation_outcome: 'RECONCILIATION_REQUIRED',
      revision: 3,
      state: 'RECONCILIATION_REQUIRED',
    } as const;
    const port = counterpartyAccessPortForTransaction(
      dependenciesWith(
        invokerWith((routineKey, values) => {
          if (routineKey === 'counterparty-access.mutate-invitation') {
            invitationOperations.push(values[4]);
            return values[4] === 'BEGIN_CLAIM' ? [invitationRow('CLAIMING')] : [reconciliationRow];
          }
          if (routineKey === 'counterparty-access.begin-grant') {
            return [grantRow('PENDING_REVOKE', 'CONFLICT')];
          }
          return [];
        }),
      ),
    );

    const result = yield* port.claimInvitation(claimInput);
    expect(result.outcome).toBe('RECONCILIATION_REQUIRED');
    expect(invitationOperations).toEqual(['BEGIN_CLAIM', 'FINISH_RECONCILIATION']);
  }),
);

it.effect('enforces Counterparty-wide last-admin protection without foreign grant disclosure', () =>
  Effect.gen(function* verifyAccessRoutineSecurity() {
    const migration = yield* Effect.promise(() =>
      readFile(new URL('../../drizzle/20260909112255_access-routines/migration.sql', import.meta.url), 'utf-8'),
    );
    const revokeRoutine = migration.slice(
      migration.indexOf('CREATE FUNCTION "commerce_customer_context"."begin_access_revoke"'),
      migration.indexOf('CREATE FUNCTION "commerce_customer_context"."transition_access_grant"'),
    );
    const grantRoutine = migration.slice(
      migration.indexOf('CREATE FUNCTION "commerce_customer_context"."begin_access_grant"'),
      migration.indexOf('CREATE FUNCTION "commerce_customer_context"."begin_access_revoke"'),
    );
    const bootstrapCheck = grantRoutine.slice(
      grantRoutine.indexOf('IF p_bootstrap AND EXISTS'),
      grantRoutine.indexOf('  SELECT grant_row.counterparty_commerce_access_grant_id'),
    );
    const directGrantLookup = revokeRoutine.slice(
      revokeRoutine.indexOf('IF p_grant_id IS NOT NULL THEN'),
      revokeRoutine.indexOf('ELSE\n    SELECT grant_row.counterparty_commerce_access_grant_id'),
    );
    const lastAdministratorCheck = revokeRoutine.slice(
      revokeRoutine.indexOf("ELSIF p_permission_code = 'counterparty.access.manage'"),
      revokeRoutine.indexOf('  ELSE\n    UPDATE commerce_customer_context.counterparty_commerce_access_grants'),
    );

    expect(directGrantLookup).toContain('grant_row.counterparty_purchasing_profile_id = v_profile_id');
    expect(lastAdministratorCheck).not.toContain('other_admin.storefront_resource_id');
    expect(lastAdministratorCheck).toContain("other_admin.lifecycle = 'ACTIVE'");
    expect(bootstrapCheck).not.toContain('administrator.storefront_resource_id');
    expect(bootstrapCheck).toContain("administrator.permission_code = 'counterparty.access.manage'");
  }),
);

it.effect('hardens durable saga transitions and invitation claim recovery in owner routines', () =>
  Effect.gen(function* verifySagaRoutineSecurity() {
    const migration = yield* Effect.promise(() =>
      readFile(new URL('../../drizzle/20260909112255_access-routines/migration.sql', import.meta.url), 'utf-8'),
    );
    const transition = migration.slice(
      migration.indexOf('CREATE FUNCTION "commerce_customer_context"."transition_access_grant"'),
      migration.indexOf('CREATE FUNCTION "commerce_customer_context"."list_access_reconciliation"'),
    );
    const claimMutation = migration.slice(
      migration.indexOf('CREATE FUNCTION "commerce_customer_context"."mutate_access_invitation"'),
      migration.indexOf('CREATE FUNCTION "commerce_customer_context"."read_access_invitation_claim_reconciliation"'),
    );
    const claimFinalizer = migration.slice(
      migration.indexOf('CREATE FUNCTION "commerce_customer_context"."finalize_reconciled_access_invitation"'),
    );

    expect(transition).toContain('v_latest_mutation_id IS DISTINCT FROM p_mutation_id');
    expect(transition).toContain('v_operation IS DISTINCT FROM p_expected_operation');
    expect(transition).toContain("p_target_state = 'ACTIVE' AND lifecycle <> 'ACTIVE' THEN statement_timestamp()");
    expect(claimMutation).toContain("p_operation IN ('REJECT_CLAIM', 'EXPIRE_CLAIM')");
    expect(claimMutation).toContain('claim.action_invocation_id = p_action_invocation_id');
    expect(claimMutation).toContain('claimed_by_principal_id = NULL');
    expect(claimMutation).toContain('claim_proof_reference = NULL');
    expect(claimFinalizer).toContain("active_grant.lifecycle = 'ACTIVE'");
    expect(claimFinalizer).toContain('v_active_count = v_permission_count');
    expect(claimFinalizer).not.toContain('p_claimant_principal_id');
  }),
);
