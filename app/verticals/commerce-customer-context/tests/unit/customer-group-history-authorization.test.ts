import { defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';
import { Effect, Option, Predicate } from 'effect';

import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import {
  makeTestBoundAccessGate,
  testAccessSpecOf,
} from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import type { TestAccessOutcome } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';
import { customerGroupDetailRead } from '../../src/api/customer-group-detail.read.ts';
import { customerGroupHistoryRead } from '../../src/api/customer-group-history.read.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const groupRef = {
  moduleId: 'commerce.customer-context' as const,
  resourceId: '40000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.customer-context.customer-group' as const,
  tenantId,
};
const installAndReadScopeSql =
  "select current_user::text as role, set_config('ontos.tenant_id', $1, true) as tenant_id, set_config('ontos.legal_entity_id', $2, true) as legal_entity_id";
const principal = {
  authBindingId: '50000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:customer-group-history-authorization',
  authMethod: 'session' as const,
  legalEntityId,
  principalId,
  tenantId,
};
const scope = {
  ...principal,
  correlationId: 'customer-group-history-authorization',
};

const makeHarness = Effect.fn(function* makeCustomerGroupHistoryAuthorizationHarness(
  access: TestAccessOutcome = 'allowed',
) {
  let dataAccessEvidence = 0;
  let groupRoutineCalls = 0;
  const query = (text: string, params: readonly unknown[]) => {
    if (text.includes('transaction_timestamp')) {
      return Effect.succeed([{ operation_at: new Date('2026-09-21T10:00:00.000Z') }]);
    }
    if (text.includes('data_access_events')) {
      dataAccessEvidence += 1;
      return Effect.succeed([]);
    }
    // A session-setting role installs its scope and reads back the connected role in one statement.
    if (text === installAndReadScopeSql) {
      expect(params).toEqual([tenantId, legalEntityId]);
      return Effect.succeed([
        {
          legal_entity_id: legalEntityId,
          role: 'ontos_runtime',
          tenant_id: tenantId,
        },
      ]);
    }
    if (text.includes('read_customer_group')) {
      groupRoutineCalls += 1;
      return Effect.succeed([
        {
          actual_revision: 0,
          changed: false,
          group_json: Option.none(),
          outcome: 'NOT_FOUND',
        },
      ]);
    }
    return Effect.succeed([]);
  };
  const database = { executor: yield* makeTestDatabase(query) };
  const contextAccess = {
    legalEntities: ({ legalEntityIds }: { readonly legalEntityIds: readonly string[] }) =>
      Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
    modules: ({ moduleIds }: { readonly moduleIds: readonly string[] }) =>
      Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
    resources: ({
      resources,
    }: {
      readonly resources: readonly {
        readonly moduleId: string;
        readonly resourceId: string;
        readonly resourceType: string;
      }[];
    }) =>
      Effect.succeed(
        resources.map((resource) => ({
          decision: 'allowed' as const,
          key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
        })),
      ),
    tenants: ({ tenantIds }: { readonly tenantIds: readonly string[] }) =>
      Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
  };
  // The v2 gate is the only authority for a protected read; it is scripted so the suite proves the
  // runner's denied and unavailable paths without a SpiceDB behind them.
  const gate = makeTestBoundAccessGate(testAccessSpecOf(access));
  const runtime = makeReadRuntime(
    database,
    openModuleEntrypointGateway,
    { resolve: () => Effect.succeed(scope) },
    contextAccess,
    {
      accessDecision: gate.bound,
      databaseIdentities: defineDatabaseIdentityEnrollment([]),
      ownerRegistration: commerceCustomerContextRegistration,
    },
  );
  return {
    dataAccessEvidence: () => dataAccessEvidence,
    gate,
    groupRoutineCalls: () => groupRoutineCalls,
    runtime,
  };
});

const runHistory = (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
  harness.runtime.runRead({
    input: { groupRef },
    principal,
    registration: customerGroupHistoryRead,
    transport: { correlationId: scope.correlationId },
  });

it.effect('denies customer group history at the gate before transaction services or persistence', () =>
  Effect.gen(function* denyCustomerGroupHistoryPermission() {
    const harness = yield* makeHarness('denied');
    const failure = yield* Effect.flip(runHistory(harness));

    expect(Predicate.isTagged(failure, 'ReadPermissionDenied')).toBe(true);
    expect(harness.groupRoutineCalls()).toBe(0);
    expect(harness.dataAccessEvidence()).toBe(1);
    // The gate is asked about the history read's own declaration, not the ordinary group read.
    expect(
      [...harness.gate.accessDecision.askedDecisions, ...harness.gate.accessDecision.askedLists].map(
        (question) => question.carrier.accessDeclaration?.key,
      ),
    ).toEqual(['commerce.customer-context.customer-group.read-history']);
  }),
);

it.effect('fails closed on an unavailable customer group history gate', () =>
  Effect.gen(function* unavailableCustomerGroupHistoryPermission() {
    const harness = yield* makeHarness('unavailable');
    const failure = yield* Effect.flip(runHistory(harness));

    expect(Predicate.isTagged(failure, 'ReadPermissionUnavailable')).toBe(true);
    expect(harness.groupRoutineCalls()).toBe(0);
    expect(harness.dataAccessEvidence()).toBe(0);
  }),
);

it.effect('keeps ordinary customer group reads on their own declaration', () =>
  Effect.gen(function* allowOrdinaryCustomerGroupReadPermission() {
    const harness = yield* makeHarness('allowed');
    const failure = yield* Effect.flip(
      harness.runtime.runRead({
        input: { groupRef },
        principal,
        registration: customerGroupDetailRead,
        transport: { correlationId: scope.correlationId },
      }),
    );

    expect(harness.groupRoutineCalls()).toBe(1);
    expect(harness.gate.accessDecision.askedDecisions.map((input) => input.carrier.accessDeclaration?.key)).toEqual([
      'commerce.customer-context.customer-group.read',
    ]);
    expect(Predicate.isTagged(failure, 'ReadHandlerNotFound')).toBe(true);
  }),
);
