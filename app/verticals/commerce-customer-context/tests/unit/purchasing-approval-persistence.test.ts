// @effect-diagnostics nodeBuiltinImport:off -- This contract reads checked-in migration/source evidence; expires: 2027-03-31.
import { readFileSync } from 'node:fs';

import { Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ScopedRoutineInvocationError } from '@app/core-runtime';

import {
  purchasingApprovalRoutineAllowlist,
  purchasingApprovalWorkflowForScope,
} from '../../src/persistence/purchasing-approval-persistence.ts';
import type { OperationalScope } from '@app/core-runtime';
import type { PurchasingApprovalScopedRoutineInvoker } from '../../src/persistence/purchasing-approval-persistence.ts';

const persistenceSource = readFileSync(
  new URL('../../src/persistence/purchasing-approval-persistence.ts', import.meta.url),
  'utf-8',
);
const routineMigration = readFileSync(
  new URL(
    '../../drizzle/20260909160000_purchasing_approval_routines/migration.sql',
    import.meta.url,
  ),
  'utf-8',
);

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
  expect(
    purchasingApprovalRoutineAllowlist.map(({ name, routineKey }) => [name, routineKey]),
  ).toEqual(routineNames);
  for (const routine of purchasingApprovalRoutineAllowlist) {
    expect(Object.isFrozen(routine)).toBe(true);
    expect(routine.ownerModuleKey).toBe('commerce.customer-context');
    expect(routine.parameters).toEqual([
      { source: 'tenantId', type: 'uuid' },
      { source: 'legalEntityId', type: 'uuid' },
      { source: 'input', type: 'jsonb' },
    ]);
  }
  expect(persistenceSource).toContain('transaction.invoke');
  expect(persistenceSource).not.toContain('new Map');
  expect(persistenceSource).not.toContain('TenantStore');
  expect(persistenceSource).not.toContain('randomUUID');
});

it('ships SECURITY DEFINER owner routines with forced RLS and no direct table grants', () => {
  for (const [name] of routineNames) {
    expect(routineMigration).toContain(
      `CREATE OR REPLACE FUNCTION "commerce_customer_context"."${name}"(`,
    );
    expect(routineMigration).toContain(
      `REVOKE ALL ON FUNCTION "commerce_customer_context"."${name}"(uuid, uuid, jsonb) FROM PUBLIC, ontos_runtime;`,
    );
    expect(routineMigration).toContain(
      `GRANT EXECUTE ON FUNCTION "commerce_customer_context"."${name}"(uuid, uuid, jsonb) TO ontos_runtime;`,
    );
  }
  // The purchase-limit Currentness adapter adds one read-only owner routine to
  // this module migration; it is intentionally not part of the mutation
  // workflow allowlist above.
  expect(routineMigration.match(/SECURITY DEFINER/gu)).toHaveLength(routineNames.length + 1);
  expect(routineMigration.match(/SET row_security = on/gu)).toHaveLength(routineNames.length + 1);
  expect(routineMigration).toContain(
    'REVOKE ALL ON TABLE\n  "commerce_customer_context"."approval_decisions"',
  );
  expect(routineMigration).toContain(
    'ALTER TABLE "commerce_customer_context"."approval_decisions" FORCE ROW LEVEL SECURITY;',
  );
  expect(routineMigration).toContain(
    'ALTER TABLE "commerce_customer_context"."purchase_proposal_revisions" FORCE ROW LEVEL SECURITY;',
  );
});

it('retains durable CAS and idempotency guards in every mutating workflow', () => {
  expect(routineMigration).toContain('FOR UPDATE');
  expect(routineMigration).toContain("USING ERRCODE = '40001'");
  expect(routineMigration).toContain("USING ERRCODE = '23505'");
  expect(routineMigration).toContain('idempotency_key = v_idempotency');
  expect(routineMigration).toContain(
    "request_revision = (p_payload->>'expectedRequestRevision')::integer",
  );
  expect(routineMigration).toContain('GET DIAGNOSTICS v_inserted = ROW_COUNT;');
  expect(routineMigration).toContain('v_existing_route approval_routes%ROWTYPE;');
  expect(routineMigration).toContain('ccc_approval_requests_active_proposal_uk');
  expect(routineMigration).toContain('committed_order_ref');
  expect(routineMigration).toContain(
    "v_request_row.request_snapshot->>'consumptionIdempotencyKey'",
  );
  expect(routineMigration).toContain("v_request_row.request_snapshot->>'consumedAt'");
  expect(routineMigration).toContain("v_request_row.request_snapshot->'consumptionEvidence'");
  expect(routineMigration).toContain('v_request_row.expires_at <= v_operation_at');
  expect(routineMigration).toContain("'requiresNewProposal', true");
  expect(routineMigration).toContain(
    "proposal_snapshot = proposal_snapshot || jsonb_build_object('state', 'SUPERSEDED')",
  );
  expect(routineMigration).toContain('LIMIT 1 FOR UPDATE');
  expect(routineMigration).toContain(
    'approval request identity conflicts with an existing submission',
  );
});

it.effect('binds submit to the explicit immutable proposal revision', () =>
  Effect.gen(function* () {
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
      workflow.forActionInvocation(invocationId).submitRequest({
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
        requestExpiresAt: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
          '2026-09-09T13:00:00.000Z',
        ),
        storefrontId: 'storefront-1',
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(invokedValues?.[0]).toMatchObject({
      actionInvocationId: invocationId,
      proposalRevision: 7,
    });
  }),
);

it.effect('keeps Order reconciliation bound to the exact approval commitment', () =>
  Effect.gen(function* () {
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
      workflow.forActionInvocation(invocationId).consume({
        counterpartyRef: {
          moduleId: 'party.registry',
          resourceId: 'counterparty-1',
          resourceType: 'party.registry.counterparty',
          tenantId: scope.tenantId,
        },
        requestRef: {
          moduleId: 'commerce.customer-context',
          resourceId: 'request-1',
          resourceType: 'commerce.customer-context.purchase-approval-request',
          tenantId: scope.tenantId,
        },
        proposalRevisionRef: {
          moduleId: 'commerce.customer-context',
          resourceId: 'proposal-1',
          resourceType: 'commerce.customer-context.purchase-proposal-revision',
          tenantId: scope.tenantId,
        },
        decisionBundleHash: 'a'.repeat(64),
        decisionBundleVersion: 'approval-decision-bundle.v1',
        commitmentCorrelationId: 'order-attempt-1',
        orderRef: {
          moduleId: 'commerce.order',
          resourceId: 'order-1',
          resourceType: 'commerce.order.order',
          tenantId: scope.tenantId,
        },
        idempotencyKey: 'order-attempt-1',
        committedAt: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
          '2026-09-09T13:00:00.000Z',
        ),
        storefrontId: 'storefront-1',
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(invokedValues?.[0]).toMatchObject({
      actionInvocationId: invocationId,
      commitmentCorrelationId: 'order-attempt-1',
      orderRef: { resourceId: 'order-1' },
    });
  }),
);

it('does not derive request identity from a missing revision on the proposal ref', () => {
  expect(routineMigration).toContain('v_proposal_revision integer;');
  expect(routineMigration).toContain('AND revision = v_proposal_revision');
  expect(routineMigration).toContain(
    "v_request_id := 'approval-request:' || v_proposal_id || ':' || v_proposal_row.revision;",
  );
  expect(routineMigration).not.toContain("(p_payload->'proposalRevisionRef'->>'revision')");
});

it('keeps proposal lineage, hierarchy provenance, and reroute history owner-derived', () => {
  expect(
    routineMigration.match(
      /CREATE UNIQUE INDEX IF NOT EXISTS "ccc_purchase_proposals_current_resource_uk"/gu,
    ),
  ).toHaveLength(1);
  expect(routineMigration).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS "ccc_purchase_proposals_current_cart_revision_uk"',
  );
  expect(routineMigration).toContain("proposal_snapshot->'sourceCart'->'cartRef'->>'resourceId'");
  expect(routineMigration).toContain("proposal_snapshot->'sourceCart'->>'revision'");
  expect(routineMigration).toContain("v_proposal->>'approvalEvaluation' <> 'APPROVAL_REQUIRED'");
  expect(routineMigration).toContain(
    "v_proposal->'sourceCart'->'cartRef'->>'resourceType' <> 'commerce.cart.cart'",
  );
  expect(routineMigration).toContain(
    "v_proposal->'sourceCart'->'cartRef'->>'tenantId' <> p_tenant_id::text",
  );
  expect(routineMigration).toContain("source->>'source' = 'purchase-proposal'");
  expect(routineMigration).toContain(
    "source->>'revision' = proposal_snapshot->'purchaseValue'->>'sourceRevision'",
  );
  expect(routineMigration).toContain("h.revision = (v_route->>'hierarchyRevision')::integer");
  expect(routineMigration).toContain("hierarchy_snapshot->>'state' = 'ACTIVE'");
  expect(routineMigration).toContain("principal->>'tenantId' IS DISTINCT FROM p_tenant_id::text");
  expect(routineMigration).toContain('v_operation_at timestamptz := now();');
  expect(routineMigration).toContain(
    "v_route_id := 'approval-route:' || v_request_id || ':reroute:'",
  );
  expect(routineMigration).toContain(
    "v_route_id := 'approval-route:' || v_request_id || ':reroute-required:'",
  );
  expect(routineMigration).toContain("status = 'SUPERSEDED'");
  expect(routineMigration).toContain("'outcome', 'REROUTE_REQUIRED'");
  expect(routineMigration).toContain("'status', 'REROUTE_REQUIRED'");
  expect(routineMigration).not.toContain("CONSTRAINT = 'pa_reroute_required'");
  expect(routineMigration).toContain('v_reroute_required boolean := false;');
  expect(routineMigration).toContain("CONSTRAINT = 'pa_decision_reason_required'");
  expect(routineMigration).toContain("CONSTRAINT = 'pa_revalidation_expired'");
  expect(routineMigration).toContain('v_existing.checked_at > v_now');
  expect(routineMigration).toContain('v_existing.valid_until <= v_now');
  expect(routineMigration).toContain("(p_payload->>'checkedAt')::timestamptz > v_now");
  expect(routineMigration).toContain("(p_payload->>'validUntil')::timestamptz <= v_now");
  expect(routineMigration).toContain("level->>'completionRule' IS DISTINCT FROM 'ONE_APPROVER'");
  expect(routineMigration).toContain("'completionRule', level->>'completionRule'");
  expect(routineMigration).toContain("CONSTRAINT = 'pa_commitment_conflict'");
});

it.effect('maps durable idempotency and serialization SQLSTATEs to typed retry outcomes', () =>
  Effect.gen(function* mapRoutineFailureEffect() {
    const scope: OperationalScope = {
      authMethod: 'system',
      correlationId: 'purchasing-approval-failure-contract',
      legalEntityId: '10000000-0000-4000-8000-000000000002',
      principalId: '10000000-0000-4000-8000-000000000003',
      tenantId: '10000000-0000-4000-8000-000000000001',
    };
    const baseInput = {
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
      requestExpiresAt: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
        '2026-09-09T13:00:00.000Z',
      ),
      storefrontId: 'storefront-1',
    };
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
    const idempotencyWorkflow = yield* purchasingApprovalWorkflowForScope(
      idempotencyInvoker,
      scope,
    );
    const serializationWorkflow = yield* purchasingApprovalWorkflowForScope(
      serializationInvoker,
      scope,
    );
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
    const input = {
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
      requestExpiresAt: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
        '2026-09-09T13:00:00.000Z',
      ),
      storefrontId: 'storefront-1',
    };
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
