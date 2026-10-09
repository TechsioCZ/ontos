import { Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ScopedRoutineInvocationError } from '@app/core-runtime';

import {
  purchasingApprovalRoutineAllowlist,
  purchasingApprovalWorkflowForScope,
} from '../../src/persistence/purchasing-approval-persistence.ts';
import {
  ConsumePurchaseApprovalInputSchema,
  SubmitPurchaseApprovalRequestInputSchema,
} from '../../shared/domain/purchasing-approval.ts';
import type { OperationalScope } from '@app/core-runtime';
import type { PurchasingApprovalScopedRoutineInvoker } from '../../src/persistence/purchasing-approval-persistence.ts';

const routineNames = [
  ['create_purchase_proposal_revision', 'purchasing-approval.create-proposal-revision'],
  ['create_approval_hierarchy', 'purchasing-approval.create-hierarchy'],
  ['submit_purchase_approval_request', 'purchasing-approval.submit-request'],
  ['decide_purchase_approval_request', 'purchasing-approval.decide-request'],
  ['reroute_purchase_approval_request', 'purchasing-approval.reroute-request'],
  ['read_current_purchase_approval_revalidation', 'purchasing-approval.read-current-revalidation'],
  ['revalidate_purchase_approval', 'purchasing-approval.revalidate'],
  ['consume_purchase_approval', 'purchasing-approval.consume'],
] as const;

it('keeps the Purchasing Approval owner boundary exact and transaction-scoped', () => {
  expect(purchasingApprovalRoutineAllowlist.map(({ name, routineKey }) => [name, routineKey])).toEqual(routineNames);
  for (const routine of purchasingApprovalRoutineAllowlist) {
    expect(Object.isFrozen(routine)).toBe(true);
    expect(routine.ownerModuleKey).toBe('commerce.customer-context');
    expect(routine.parameters).toEqual([
      { source: 'tenantId', type: 'uuid' },
      { source: 'legalEntityId', type: 'uuid' },
      { source: 'input', type: 'jsonb' },
    ]);
  }
});

it.effect('binds submit to the explicit immutable proposal revision', () =>
  Effect.gen(function* bindSubmitToImmutableProposalRevision() {
    let invokedValues: readonly unknown[] | undefined;
    const invoker: PurchasingApprovalScopedRoutineInvoker = {
      invoke: (_routine, values) => {
        invokedValues = values;
        return Effect.succeed([]);
      },
    };
    const scope: OperationalScope = {
      authMethod: 'system',
      correlationId: 'purchasing-approval-submit-contract',
      legalEntityId: '10000000-0000-4000-8000-000000000002',
      principalId: '10000000-0000-4000-8000-000000000003',
      tenantId: '10000000-0000-4000-8000-000000000001',
    };
    const workflow = yield* purchasingApprovalWorkflowForScope(invoker, scope);
    const invocationId = '50000000-0000-4000-8000-000000000001';
    const exit = yield* Effect.exit(
      workflow.forActionInvocation(invocationId).submitRequest(
        Schema.decodeUnknownSync(SubmitPurchaseApprovalRequestInputSchema)({
          counterpartyRef: {
            moduleId: 'party.registry',
            resourceId: 'counterparty-1',
            resourceType: 'party.registry.counterparty',
            tenantId: scope.tenantId,
          },
          idempotencyKey: 'submit-contract-1',
          proposalRevision: 7,
          proposalRevisionRef: {
            moduleId: 'commerce.customer-context',
            resourceId: 'proposal-1',
            resourceType: 'commerce.customer-context.purchase-proposal-revision',
            tenantId: scope.tenantId,
          },
          requestExpiresAt: '2026-09-09T13:00:00.000Z',
          storefrontId: 'storefront-1',
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(invokedValues?.[0]).toMatchObject({
      actionInvocationId: invocationId,
      proposalRevision: 7,
    });
  }),
);

it.effect('keeps Order reconciliation bound to the exact approval commitment', () =>
  Effect.gen(function* keepOrderReconciliationBoundToApprovalCommitment() {
    let invokedValues: readonly unknown[] | undefined;
    const invoker: PurchasingApprovalScopedRoutineInvoker = {
      invoke: (_routine, values) => {
        invokedValues = values;
        return Effect.succeed([]);
      },
    };
    const scope: OperationalScope = {
      authMethod: 'system',
      correlationId: 'purchasing-approval-consume-contract',
      legalEntityId: '10000000-0000-4000-8000-000000000002',
      principalId: '10000000-0000-4000-8000-000000000003',
      tenantId: '10000000-0000-4000-8000-000000000001',
    };
    const workflow = yield* purchasingApprovalWorkflowForScope(invoker, scope);
    const invocationId = '50000000-0000-4000-8000-000000000002';
    const exit = yield* Effect.exit(
      workflow.forActionInvocation(invocationId).consume(
        Schema.decodeUnknownSync(ConsumePurchaseApprovalInputSchema)({
          commitmentCorrelationId: 'order-attempt-1',
          committedAt: '2026-09-09T13:00:00.000Z',
          counterpartyRef: {
            moduleId: 'party.registry',
            resourceId: 'counterparty-1',
            resourceType: 'party.registry.counterparty',
            tenantId: scope.tenantId,
          },
          decisionBundleHash: 'a'.repeat(64),
          decisionBundleVersion: 'approval-decision-bundle.v1',
          idempotencyKey: 'order-attempt-1',
          orderRef: {
            moduleId: 'commerce.order',
            resourceId: 'order-1',
            resourceType: 'commerce.order.order',
            tenantId: scope.tenantId,
          },
          proposalRevisionRef: {
            moduleId: 'commerce.customer-context',
            resourceId: 'proposal-1',
            resourceType: 'commerce.customer-context.purchase-proposal-revision',
            tenantId: scope.tenantId,
          },
          requestRef: {
            moduleId: 'commerce.customer-context',
            resourceId: 'request-1',
            resourceType: 'commerce.customer-context.purchase-approval-request',
            tenantId: scope.tenantId,
          },
          storefrontId: 'storefront-1',
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(invokedValues?.[0]).toMatchObject({
      actionInvocationId: invocationId,
      commitmentCorrelationId: 'order-attempt-1',
      orderRef: { resourceId: 'order-1' },
    });
  }),
);

it.effect('maps durable idempotency and serialization SQLSTATEs to typed retry outcomes', () =>
  Effect.gen(function* mapRoutineFailureEffect() {
    const scope: OperationalScope = {
      authMethod: 'system',
      correlationId: 'purchasing-approval-failure-contract',
      legalEntityId: '10000000-0000-4000-8000-000000000002',
      principalId: '10000000-0000-4000-8000-000000000003',
      tenantId: '10000000-0000-4000-8000-000000000001',
    };
    const baseInput = Schema.decodeUnknownSync(SubmitPurchaseApprovalRequestInputSchema)({
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: 'counterparty-1',
        resourceType: 'party.registry.counterparty',
        tenantId: scope.tenantId,
      },
      idempotencyKey: 'submit-contract-2',
      proposalRevision: 7,
      proposalRevisionRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'proposal-1',
        resourceType: 'commerce.customer-context.purchase-proposal-revision',
        tenantId: scope.tenantId,
      },
      requestExpiresAt: '2026-09-09T13:00:00.000Z',
      storefrontId: 'storefront-1',
    });
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this failure factory isolated to the SQLSTATE mapping test.
    const failureFor = (postgresCode: string) =>
      new ScopedRoutineInvocationError({
        code: 'scoped_routine_invocation_failed',
        constraint: Option.none(),
        ownerModuleKey: 'commerce.customer-context',
        postgresCode: Option.some(postgresCode),
        reason: 'durable routine rejected the command',
        routineKey: 'purchasing-approval.submit-request',
      });
    const idempotencyInvoker: PurchasingApprovalScopedRoutineInvoker = {
      invoke: () => Effect.fail(failureFor('23505')),
    };
    const serializationInvoker: PurchasingApprovalScopedRoutineInvoker = {
      invoke: () => Effect.fail(failureFor('40001')),
    };
    const idempotencyWorkflow = yield* purchasingApprovalWorkflowForScope(idempotencyInvoker, scope);
    const serializationWorkflow = yield* purchasingApprovalWorkflowForScope(serializationInvoker, scope);
    const idempotencyFailure = yield* Effect.flip(idempotencyWorkflow.submitRequest(baseInput));
    const serializationFailure = yield* Effect.flip(serializationWorkflow.submitRequest(baseInput));
    expect(idempotencyFailure).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      retryable: false,
    });
    expect(serializationFailure).toMatchObject({
      code: 'COMMIT_CONFLICT',
      retryable: true,
    });
  }),
);

it.effect('maps stable owner constraints without inspecting sanitized SQL reasons', () =>
  Effect.gen(function* mapsStableOwnerConstraints() {
    const scope: OperationalScope = {
      authMethod: 'system',
      correlationId: 'purchasing-approval-constraint-contract',
      legalEntityId: '10000000-0000-4000-8000-000000000002',
      principalId: '10000000-0000-4000-8000-000000000003',
      tenantId: '10000000-0000-4000-8000-000000000001',
    };
    const input = Schema.decodeUnknownSync(SubmitPurchaseApprovalRequestInputSchema)({
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: 'counterparty-1',
        resourceType: 'party.registry.counterparty',
        tenantId: scope.tenantId,
      },
      idempotencyKey: 'submit-contract-constraints',
      proposalRevision: 7,
      proposalRevisionRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'proposal-1',
        resourceType: 'commerce.customer-context.purchase-proposal-revision',
        tenantId: scope.tenantId,
      },
      requestExpiresAt: '2026-09-09T13:00:00.000Z',
      storefrontId: 'storefront-1',
    });
    const cases = [
      ['pa_not_route_eligible', 'NOT_ROUTE_ELIGIBLE'],
      ['pa_self_approval', 'SELF_APPROVAL_DENIED'],
      ['pa_request_not_pending', 'REQUEST_NOT_PENDING'],
      ['pa_request_expired', 'REQUEST_EXPIRED'],
      ['pa_proposal_material', 'PROPOSAL_MATERIAL_CHANGE'],
      ['pa_buyer_denied', 'BUYER_PERMISSION_DENIED'],
      ['pa_profile_inactive', 'PROFILE_INACTIVE'],
      ['pa_policy_route', 'POLICY_ROUTE_INVALID'],
      ['pa_proposal_not_current', 'PROPOSAL_NOT_CURRENT'],
      ['pa_hierarchy_invalid', 'HIERARCHY_RANGE_INVALID'],
      ['pa_target_mismatch', 'PERMISSION_DENIED'],
      ['pa_hierarchy_missing', 'HIERARCHY_NOT_FOUND'],
      ['pa_hierarchy_ambiguous', 'HIERARCHY_AMBIGUOUS'],
      ['pa_route_empty', 'NO_ELIGIBLE_ROUTE'],
      ['pa_reroute_required', 'NO_ELIGIBLE_ROUTE'],
      ['pa_decision_reason_required', 'PERMISSION_DENIED'],
      ['pa_revalidation_expired', 'REQUEST_EXPIRED'],
    ] as const;
    for (const [constraint, code] of cases) {
      const invoker: PurchasingApprovalScopedRoutineInvoker = {
        invoke: () =>
          Effect.fail(
            new ScopedRoutineInvocationError({
              code: 'scoped_routine_invocation_failed',
              constraint: Option.some(constraint),
              ownerModuleKey: 'commerce.customer-context',
              postgresCode: Option.some('P0001'),
              reason: 'redacted by Core',
              routineKey: 'purchasing-approval.submit-request',
            }),
          ),
      };
      const workflow = yield* purchasingApprovalWorkflowForScope(invoker, scope);
      const failure = yield* Effect.flip(workflow.submitRequest(input));
      expect(failure).toMatchObject({ code, retryable: false });
    }
  }),
);
