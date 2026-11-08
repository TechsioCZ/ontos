import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import {
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  TrustedPrincipalContextSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { getReadResultPermissionTargetResolver } from '../../../../packages/core-runtime/src/reads/definition.ts';
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
import { CustomerHistoryPortsService, unavailableCustomerHistoryPorts } from '../../shared/domain/history-ports.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';

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
  invoke: (routine) =>
    Schema.decodeUnknownEffect(Schema.Array(Schema.toType(routine.resultSchema)))([
      {
        outcome: 'PROFILE_AVAILABLE',
        payload: counterpartyProfilePayload(state, overrides),
      },
    ]).pipe(Effect.orDie),
});
it.effect('keeps exact Counterparty history association independent from the new-order lifecycle gate', () =>
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

      const tradingGate = yield* profilePersistenceServicesForTransaction(profileTransaction(state), profileScope, {
        resolveCounterpartyRole: () => Effect.succeed(role),
      }).customerProfileTradingGate.evaluateGate(profileInput, tenantId);
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

it('declares one scope-wide capability per history Read with the owner facts that name its record', () => {
  // The legacy business/Resource permission-target resolvers are gone (O62.4): each protected Read
  // carries a v2 declaration and the owner facts that name the record whose own grant the overlay
  // checks (O67-Q1, O70).
  for (const [read, key] of [
    [retailOrderHistoryRead, 'commerce.customer-context.retail-order-history.read'],
    [counterpartyOrderHistoryRead, 'commerce.customer-context.counterparty-order-history.read-own'],
    [counterpartyAllOrderHistoryRead, 'commerce.customer-context.counterparty-order-history.read-all'],
    [counterpartyAllCustomerArchiveRead, 'commerce.customer-context.counterparty-customer-archive.read-all'],
  ] as const) {
    expect(read.descriptor.accessDeclaration?.key).toBe(key);
    expect(read.descriptor.accessDeclaration?.selectors).toEqual([]);
    expect(read.descriptor.accessOwnerFacts).toBeDefined();
    expect(read.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
  }
});

it('gates authoritative detail with the exact scope and owner facts before owner ports', () => {
  for (const [read, key] of [
    [retailOrderHistoryDetailRead, 'commerce.customer-context.retail-order-history.read-detail'],
    [counterpartyOrderHistoryDetailRead, 'commerce.customer-context.counterparty-order-history.read-detail-own'],
    [counterpartyAllOrderHistoryDetailRead, 'commerce.customer-context.counterparty-order-history.read-detail-all'],
  ] as const) {
    expect(read.descriptor.accessDeclaration?.key).toBe(key);
    expect(read.descriptor.accessDeclaration?.selectors).toEqual([]);
    expect(read.descriptor.accessOwnerFacts).toBeDefined();
  }
  expect(getReadResultPermissionTargetResolver(retailOrderHistoryDetailRead)).toBeUndefined();
});

it('makes cross-tenant references invalid through the Read own scope, not a permission resolver', () => {
  // The per-tenant permission resolver is gone: a foreign profile is refused by the read's own
  // trusted-scope check and the owner facts that name the profile, never by a resolver target.
  expect(retailOrderHistoryRead.descriptor.accessOwnerFacts).toBeDefined();
  expect(retailOrderHistoryRead.descriptor.accessDeclaration?.selectors).toEqual([]);
});

it('does not attach illegal generic result filtering to business-permission Reads', () => {
  expect(getReadResultPermissionTargetResolver(retailOrderHistoryRead)).toBeUndefined();
  expect(getReadResultPermissionTargetResolver(counterpartyOrderHistoryRead)).toBeUndefined();
  expect(getReadResultPermissionTargetResolver(counterpartyAllOrderHistoryRead)).toBeUndefined();
  expect(getReadResultPermissionTargetResolver(counterpartyAllCustomerArchiveRead)).toBeUndefined();
});

it.effect('runs the handler only after the gate allows and fails closed when it denies', () =>
  Effect.scoped(
    Effect.gen(function* runtimeAuthorization() {
      const compositionRevision = 'a'.repeat(64);
      const verified = trustVerifiedGatewayPrincipalContext(
        Schema.decodeSync(TrustedPrincipalContextSchema)(principal),
        compositionRevision,
      );
      for (const access of ['allowed', 'denied'] as const) {
        const harness = yield* makeReadTestHarness({
          access,
          compositionRevision,
          executeOwnerQuery: () => Effect.die('The Retail history load must not query another owner'),
          operationTime: new Date('2026-09-21T10:00:00.000Z'),
          ownerAuthorizationDecision: 'allowed',
          ownerRegistration: commerceCustomerContextRegistration,
          scope: { ...verified, correlationId: scope.correlationId },
        });
        const failure = yield* harness.runtime
          .runRead({
            input: { profileRef: retailProfileRef },
            principal: verified,
            registration: retailOrderHistoryRead,
            transport: { correlationId: scope.correlationId },
          })
          .pipe(Effect.provideService(CustomerHistoryPortsService, unavailableCustomerHistoryPorts()), Effect.flip);
        expect(Schema.is(access === 'allowed' ? ReadHandlerUnavailable : ReadPermissionDenied)(failure)).toBe(true);
        if (access === 'denied') {
          expect(harness.snapshot().ownerQueries).toEqual([]);
        }
      }
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);
