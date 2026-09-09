import { expect, it } from 'effect-rstest';
import { Effect, Option, Predicate } from 'effect';

import { toContextPermissionAccessKey } from '@app/core-runtime';
import type { ContextAccessDecision } from '@app/core-runtime';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';
import { customerGroupDetailRead } from '../../src/api/customer-group-detail.read.ts';
import { customerGroupHistoryRead } from '../../src/api/customer-group-history.read.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const groupRef = {
  moduleId: 'commerce.customer-context' as const,
  resourceId: '40000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.customer-context.customer-group' as const,
  tenantId,
};
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
  decideContextPermission?: (permission: string) => ContextAccessDecision,
) {
  let dataAccessEvidence = 0;
  let groupRoutineCalls = 0;
  const queriedContextPermissions: string[] = [];
  const query = (text: string) => {
    if (text.includes('data_access_events')) {
      dataAccessEvidence += 1;
      return Effect.succeed([]);
    }
    if (text.includes('current_setting')) {
      return Effect.succeed([
        {
          legal_entity_id: legalEntityId,
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
  const baseContextAccess = {
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
  const contextAccess =
    decideContextPermission === undefined
      ? baseContextAccess
      : {
          ...baseContextAccess,
          contextPermissions: ({
            targets,
          }: {
            readonly targets: readonly { readonly moduleId: string; readonly permission: string }[];
          }) =>
            Effect.succeed(
              targets.map((target) => {
                queriedContextPermissions.push(target.permission);
                return {
                  decision: decideContextPermission(target.permission),
                  key: toContextPermissionAccessKey(target),
                };
              }),
            ),
        };
  const runtime = makeReadRuntime(
    database,
    openModuleEntrypointGateway,
    { resolve: () => Effect.succeed(scope) },
    contextAccess,
  );
  return {
    dataAccessEvidence: () => dataAccessEvidence,
    groupRoutineCalls: () => groupRoutineCalls,
    queriedContextPermissions,
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

it.effect('denies customer group history before transaction services or persistence', () =>
  Effect.gen(function* denyCustomerGroupHistoryPermission() {
    const harness = yield* makeHarness((permission) =>
      permission === 'customer.group.history.read' ? 'denied' : 'allowed',
    );
    const failure = yield* Effect.flip(runHistory(harness));

    expect(Predicate.isTagged(failure, 'ReadPermissionDenied')).toBe(true);
    expect(harness.groupRoutineCalls()).toBe(0);
    expect(harness.dataAccessEvidence()).toBe(1);
    expect(harness.queriedContextPermissions).toEqual(['customer.group.history.read']);
  }),
);

it.effect('fails closed on indeterminate or missing customer group history permission', () =>
  Effect.gen(function* unavailableCustomerGroupHistoryPermission() {
    const indeterminate = yield* makeHarness(() => 'unavailable');
    const missing = yield* makeHarness();

    const indeterminateFailure = yield* Effect.flip(runHistory(indeterminate));
    const missingFailure = yield* Effect.flip(runHistory(missing));

    expect(Predicate.isTagged(indeterminateFailure, 'ReadPermissionUnavailable')).toBe(true);
    expect(Predicate.isTagged(missingFailure, 'ReadPermissionUnavailable')).toBe(true);
    expect(indeterminate.groupRoutineCalls()).toBe(0);
    expect(missing.groupRoutineCalls()).toBe(0);
    expect(indeterminate.dataAccessEvidence()).toBe(0);
    expect(missing.dataAccessEvidence()).toBe(0);
  }),
);

it.effect('keeps ordinary customer group reads on their independent read permission', () =>
  Effect.gen(function* allowOrdinaryCustomerGroupReadPermission() {
    const harness = yield* makeHarness((permission) =>
      permission === 'customer.group.read' ? 'allowed' : 'denied',
    );
    const failure = yield* Effect.flip(
      harness.runtime.runRead({
        input: { groupRef },
        principal,
        registration: customerGroupDetailRead,
        transport: { correlationId: scope.correlationId },
      }),
    );

    expect(harness.groupRoutineCalls()).toBe(1);
    expect(harness.queriedContextPermissions).toEqual(['customer.group.read']);
    expect(Predicate.isTagged(failure, 'ReadHandlerNotFound')).toBe(true);
  }),
);
