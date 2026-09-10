import { expect, it } from 'effect-rstest';
import { Effect, Predicate, Schema } from 'effect';
import {
  ReadHandlerUnavailable,
  allowOwnerAuthorizationOverlay,
  toBusinessPermissionAccessKey,
} from '@app/core-runtime';
import {
  getReadPermissionTargetResolver,
  getReadResourcePermissionTargetResolver,
  getReadResultPermissionTargetResolver,
} from '../../../../packages/core-runtime/src/reads/definition.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';
import { counterpartyAllOrderHistoryRead } from '../../src/api/counterparty-all-order-history.read.ts';
import { counterpartyAllCustomerArchiveRead } from '../../src/api/counterparty-all-customer-archive.read.ts';
import { counterpartyAllOrderHistoryDetailRead } from '../../src/api/counterparty-all-order-history-detail.read.ts';
import { counterpartyOrderHistoryRead } from '../../src/api/counterparty-order-history.read.ts';
import { counterpartyOrderHistoryDetailRead } from '../../src/api/counterparty-order-history-detail.read.ts';
import { retailOrderHistoryRead } from '../../src/api/retail-order-history.read.ts';
import { retailOrderHistoryDetailRead } from '../../src/api/retail-order-history-detail.read.ts';
import { customerHistoryPortsForOperation } from '../../src/history-production-services.ts';
import type {
  ProfilePersistenceScope,
  ProfileScopedRoutineInvoker,
} from '../../src/persistence/profile-persistence.ts';
import { profilePersistenceServicesForTransaction } from '../../src/persistence/profile-persistence.ts';
import {
  CustomerHistoryPortsService,
  unavailableCustomerHistoryPorts,
} from '../../shared/domain/history-ports.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const scope = {
  authBindingId: '55555555-5555-4555-8555-555555555555',
  authContextRef: 'better-auth-session:history-read-authorization-test',
  authMethod: 'session' as const,
  correlationId: 'history-read-authorization',
  legalEntityId: '22222222-2222-4222-8222-222222222222',
  principalId: '33333333-3333-4333-8333-333333333333',
  tenantId,
};
const principal = {
  authBindingId: '55555555-5555-4555-8555-555555555555',
  authContextRef: 'better-auth-session:history-read-authorization-test',
  authMethod: 'session' as const,
  legalEntityId: scope.legalEntityId,
  principalId: scope.principalId,
  tenantId,
};
const retailProfileRef = {
  moduleId: 'commerce.customer-context' as const,
  resourceId: 'retail-profile-1',
  resourceType: 'commerce.customer-context.retail-customer-profile' as const,
  tenantId,
};
const counterpartyProfileRef = {
  moduleId: 'commerce.customer-context' as const,
  resourceId: 'counterparty-profile-1',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
  tenantId,
};
const taggedCounterpartyProfileRef = {
  ...counterpartyProfileRef,
  kind: 'COUNTERPARTY' as const,
};
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: 'counterparty-1',
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};

const profileScope: ProfilePersistenceScope = {
  legalEntityId: scope.legalEntityId,
  principalId: scope.principalId,
  tenantId,
};

const counterpartyProfilePayload = (
  state: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED',
  overrides: {
    readonly counterpartyResourceId?: string;
    readonly profileId?: string;
  } = {},
) => ({
  createdAt: '2026-09-09T09:00:00.000Z',
  profileId: overrides.profileId ?? counterpartyProfileRef.resourceId,
  profileKind: 'COUNTERPARTY' as const,
  revision: 3,
  scopeLegalEntityId: scope.legalEntityId,
  state,
  subject: {
    counterpartyResourceId: overrides.counterpartyResourceId ?? counterpartyRef.resourceId,
    counterpartyResourceRevision: 'counterparty:7',
    customerRoleResourceId: 'customer-role-1',
    customerRoleResourceRevision: 'customer-role:4',
    kind: 'COUNTERPARTY' as const,
  },
  updatedAt: '2026-09-09T09:00:00.000Z',
});

const profileTransaction = (
  state: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED',
  overrides: Parameters<typeof counterpartyProfilePayload>[1] = {},
): ProfileScopedRoutineInvoker => ({
  invoke: () =>
    Effect.succeed([
      {
        outcome: 'PROFILE_AVAILABLE',
        payload: counterpartyProfilePayload(state, overrides),
      },
    ]),
});
const orderRef = {
  moduleId: 'commerce.order',
  resourceId: 'order-1',
  resourceType: 'commerce.order.order',
  tenantId,
};

it.effect(
  'keeps exact Counterparty history association independent from the new-order lifecycle gate',
  () =>
    Effect.gen(function* counterpartyLifecycleSeparation() {
      const states = ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const;
      const profileInput = {
        authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' as const },
        profileRef: taggedCounterpartyProfileRef,
      };
      const role = {
        managedLegalEntityId: scope.legalEntityId,
        outcome: 'ELIGIBLE' as const,
        roleResourceId: 'customer-role-1',
        roleResourceRevision: 'customer-role:4',
      };

      for (const state of states) {
        const historyPorts = yield* customerHistoryPortsForOperation(
          unavailableCustomerHistoryPorts(),
          profileTransaction(state),
          scope,
        );
        const association = yield* historyPorts.counterpartyProfiles.current({
          counterpartyRef,
          profileRef: counterpartyProfileRef,
        });
        expect(association).toBe('CURRENT');

        const tradingGate = yield* profilePersistenceServicesForTransaction(
          profileTransaction(state),
          profileScope,
          { resolveCounterpartyRole: () => Effect.succeed(role) },
        ).customerProfileTradingGate.evaluateGate(profileInput, tenantId);
        expect(tradingGate.gate).toEqual({
          canAcceptNewOrder: state === 'ACTIVE',
          outcome: state,
        });
      }

      for (const mismatch of [
        { counterpartyResourceId: counterpartyRef.resourceId, profileId: 'counterparty-profile-2' },
        { counterpartyResourceId: 'counterparty-2', profileId: counterpartyProfileRef.resourceId },
      ]) {
        const historyPorts = yield* customerHistoryPortsForOperation(
          unavailableCustomerHistoryPorts(),
          profileTransaction('SUSPENDED', mismatch),
          scope,
        );
        const association = yield* historyPorts.counterpartyProfiles.current({
          counterpartyRef,
          profileRef: counterpartyProfileRef,
        });
        expect(association).toBe('ABSENT');
      }
    }),
);

it('declares exact business and Resource authorization before history handlers', () => {
  const retailInput = { profileRef: retailProfileRef };
  const counterpartyInput = { counterpartyRef, profileRef: counterpartyProfileRef };
  const retailResolver = getReadPermissionTargetResolver(retailOrderHistoryRead);
  const counterpartyOwnResolver = getReadPermissionTargetResolver(counterpartyOrderHistoryRead);
  const counterpartyAllResolver = getReadPermissionTargetResolver(counterpartyAllOrderHistoryRead);
  expect(Predicate.isFunction(retailResolver)).toBe(true);
  expect(Predicate.isFunction(counterpartyOwnResolver)).toBe(true);
  expect(Predicate.isFunction(counterpartyAllResolver)).toBe(true);
  if (
    !Predicate.isFunction(retailResolver) ||
    !Predicate.isFunction(counterpartyOwnResolver) ||
    !Predicate.isFunction(counterpartyAllResolver)
  ) {
    return;
  }

  expect(retailResolver(retailInput, scope)).toEqual({
    businessPermission: {
      permission: 'retail.history.read',
      target: {
        kind: 'retail_profile',
        legalEntityId: scope.legalEntityId,
        profileId: retailProfileRef.resourceId,
        tenantId,
      },
    },
    kind: 'business_permission',
  });
  expect(
    getReadResourcePermissionTargetResolver(retailOrderHistoryRead)?.(retailInput, scope),
  ).toEqual({ permission: 'read', resource: retailProfileRef });
  expect(counterpartyOwnResolver(counterpartyInput, scope)).toMatchObject({
    businessPermission: { permission: 'counterparty.history.read_own' },
    kind: 'business_permission',
  });
  expect(counterpartyAllResolver(counterpartyInput, scope)).toMatchObject({
    businessPermission: { permission: 'counterparty.history.read_all' },
    kind: 'business_permission',
  });
  const allArchiveResolver = getReadPermissionTargetResolver(counterpartyAllCustomerArchiveRead);
  expect(Predicate.isFunction(allArchiveResolver)).toBe(true);
  if (Predicate.isFunction(allArchiveResolver)) {
    expect(allArchiveResolver(counterpartyInput, scope)).toMatchObject({
      businessPermission: { permission: 'counterparty.history.read_all' },
      kind: 'business_permission',
    });
  }
});

it('gates authoritative detail with the exact scope and Order Resource before owner ports', () => {
  const retailInput = { orderRef, profileRef: retailProfileRef };
  const counterpartyInput = {
    counterpartyRef,
    orderRef,
    profileRef: counterpartyProfileRef,
  };
  const retailResolver = getReadPermissionTargetResolver(retailOrderHistoryDetailRead);
  const counterpartyOwnResolver = getReadPermissionTargetResolver(
    counterpartyOrderHistoryDetailRead,
  );
  const counterpartyAllResolver = getReadPermissionTargetResolver(
    counterpartyAllOrderHistoryDetailRead,
  );
  expect(Predicate.isFunction(retailResolver)).toBe(true);
  expect(Predicate.isFunction(counterpartyOwnResolver)).toBe(true);
  expect(Predicate.isFunction(counterpartyAllResolver)).toBe(true);
  if (
    !Predicate.isFunction(retailResolver) ||
    !Predicate.isFunction(counterpartyOwnResolver) ||
    !Predicate.isFunction(counterpartyAllResolver)
  ) {
    return;
  }

  expect(retailResolver(retailInput, scope)).toMatchObject({
    businessPermission: { permission: 'retail.history.read' },
  });
  expect(
    getReadResourcePermissionTargetResolver(retailOrderHistoryDetailRead)?.(retailInput, scope),
  ).toEqual({ permission: 'read', resource: orderRef });
  expect(counterpartyOwnResolver(counterpartyInput, scope)).toMatchObject({
    businessPermission: { permission: 'counterparty.history.read_own' },
  });
  expect(counterpartyAllResolver(counterpartyInput, scope)).toMatchObject({
    businessPermission: { permission: 'counterparty.history.read_all' },
  });
  expect(getReadResultPermissionTargetResolver(retailOrderHistoryDetailRead)).toBeUndefined();
});

it('makes cross-tenant references invalid before any owner port can be resolved', () => {
  const foreignProfile = {
    ...retailProfileRef,
    tenantId: '44444444-4444-4444-8444-444444444444',
  };
  const resolver = getReadPermissionTargetResolver(retailOrderHistoryRead);
  expect(Predicate.isFunction(resolver)).toBe(true);
  if (!Predicate.isFunction(resolver)) {
    return;
  }
  const target = resolver({ profileRef: foreignProfile }, scope);

  expect(target).toMatchObject({
    businessPermission: { target: { tenantId: '' } },
    kind: 'business_permission',
  });
});

it('does not attach illegal generic result filtering to business-permission Reads', () => {
  expect(getReadResultPermissionTargetResolver(retailOrderHistoryRead)).toBeUndefined();
  expect(getReadResultPermissionTargetResolver(counterpartyOrderHistoryRead)).toBeUndefined();
  expect(getReadResultPermissionTargetResolver(counterpartyAllOrderHistoryRead)).toBeUndefined();
  expect(getReadResultPermissionTargetResolver(counterpartyAllCustomerArchiveRead)).toBeUndefined();
});

it.effect('executes exact business and Resource gates before resolving unavailable owners', () =>
  Effect.gen(function* runtimeAuthorization() {
    let businessChecks = 0;
    let resourceChecks = 0;
    const database = {
      executor: yield* makeTestDatabase((text) =>
        Effect.succeed(
          text.includes('current_setting')
            ? [{ legal_entity_id: scope.legalEntityId, tenant_id: tenantId }]
            : [],
        ),
      ),
    };
    const runtime = makeReadRuntime(
      database,
      openModuleEntrypointGateway,
      { resolve: () => Effect.succeed(scope) },
      {
        businessPermissions: ({ targets }) => {
          businessChecks += 1;
          return Effect.succeed(
            targets.map((target) => ({
              decision: 'allowed' as const,
              key: toBusinessPermissionAccessKey(target),
            })),
          );
        },
        legalEntities: ({ legalEntityIds }) =>
          Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
        modules: ({ moduleIds }) =>
          Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
        resources: ({ resources }) => {
          resourceChecks += 1;
          return Effect.succeed(
            resources.map((resource) => ({
              decision: 'allowed' as const,
              key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
            })),
          );
        },
        tenants: ({ tenantIds }) =>
          Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
      },
      { ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay },
    );
    const failure = yield* runtime
      .runRead({
        input: { profileRef: retailProfileRef },
        principal,
        registration: retailOrderHistoryRead,
        transport: { correlationId: scope.correlationId },
      })
      .pipe(
        Effect.provideService(CustomerHistoryPortsService, unavailableCustomerHistoryPorts()),
        Effect.flip,
      );

    expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    expect(businessChecks).toBe(1);
    expect(resourceChecks).toBe(1);
  }),
);
