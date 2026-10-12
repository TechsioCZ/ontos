import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import type { CounterpartyCustomerOnboardPayload } from '../../shared/actions/counterparty-customer-onboard.ts';
import { counterpartyCustomerOnboardAction } from '../../src/actions/counterparty-customer-onboard.action.ts';
import { CustomerOnboardFoundSchema } from '../../src/services/counterparty-persistence.service.ts';

const tenantId = '81000000-0000-4000-8000-000000000001';
const legalEntityId = '82000000-0000-4000-8000-000000000001';
const partyId = '83000000-0000-4000-8000-000000000001';
const counterpartyId = '84000000-0000-4000-8000-000000000001';
const rolePeriodId = '85000000-0000-4000-8000-000000000001';
const principal = {
  authBindingId: '86000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:counterparty-customer-onboard-runtime',
  authMethod: 'session',
  legalEntityId,
  principalId: '87000000-0000-4000-8000-000000000001',
  tenantId,
} as const;
const partyRef = {
  moduleId: 'party.registry',
  resourceId: partyId,
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: counterpartyId,
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const legalEntityRef = {
  moduleId: 'core.identity',
  resourceId: legalEntityId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;
const rolePeriodRef = {
  moduleId: 'party.registry',
  resourceId: rolePeriodId,
  resourceType: 'party.registry.counterparty-role-period',
  tenantId,
} as const;
const payload: CounterpartyCustomerOnboardPayload = {
  counterpartyProvenance: {
    evidenceReference: 'contract:context',
    method: 'SIGNED_CONTRACT',
    reason: 'Signed commercial agreement',
    source: 'contracts.core',
  },
  customerEvidence: {
    evidenceReference: 'contract:customer',
    method: 'SIGNED_CONTRACT',
    reason: 'Signed customer agreement',
    source: 'contracts.core',
  },
  partyRef,
  validFrom: '2026-01-01T00:00:00.000Z',
};
const role = {
  endProvenance: null,
  provenance: {
    evidenceReference: 'contract:customer',
    method: 'SIGNED_CONTRACT',
    reason: 'Signed customer agreement',
    source: 'contracts.core',
  },
  recordedAt: '2026-09-03T00:00:00.000Z',
  rolePeriodRef,
  roleType: 'CUSTOMER' as const,
  state: 'ACTIVE' as const,
  validFrom: payload.validFrom,
  validTo: null,
};
const persistenceResult = (flags: { readonly counterpartyCreated: boolean; readonly rolePeriodCreated: boolean }) =>
  CustomerOnboardFoundSchema.make({
    ...flags,
    counterpartyRef,
    legalEntityRef,
    partyRef,
    role,
  });
const request = (idempotencyKey: string) => ({
  payload,
  principal,
  registration: counterpartyCustomerOnboardAction,
  transport: { correlationId: 'counterparty-customer-onboard-runtime', idempotencyKey },
});

it.effect('denies CUSTOMER onboarding before the owner handler when Action permission is absent', () =>
  Effect.gen(function* deniedOnboarding() {
    const harness = yield* makeActionTestHarness({
      actionPermission: 'denied',
      legalEntityPermission: 'allowed',
      services: [
        bindActionTestServices(counterpartyCustomerOnboardAction, {
          onboard: () => Effect.die('the denied Action must not execute its owner handler'),
        }),
      ],
      tenantPermission: 'allowed',
    });

    const failure = yield* harness.runtime.runAction(request('denied-1')).pipe(Effect.flip);

    expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
    expect(harness.snapshot().committed).toEqual([]);
    expect(harness.snapshot().permissionDenials).toHaveLength(1);
    expect(harness.snapshot().stages.includes('handler_executed')).toBe(false);
  }),
);

it.effect('recovers a committed CUSTOMER onboarding invocation without replaying owner writes', () =>
  Effect.gen(function* recoverOnboarding() {
    let calls = 0;
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      legalEntityPermission: 'allowed',
      services: [
        bindActionTestServices(counterpartyCustomerOnboardAction, {
          onboard: () =>
            Effect.sync(() => {
              calls += 1;
              return persistenceResult({ counterpartyCreated: true, rolePeriodCreated: true });
            }),
        }),
      ],
      tenantPermission: 'allowed',
    });

    const result = yield* harness.runtime.runAction(request('recover-1'));
    const [invocation] = harness.snapshot().invocations;
    expect(invocation).toBeDefined();
    if (invocation === undefined) {
      return;
    }
    const resolution = yield* harness.runtime
      .resolveActionCommit({ invocationId: invocation.actionInvocationId, principal })
      .pipe(Effect.flip);

    expect(Predicate.isTagged(resolution, 'ActionAlreadyCommitted')).toBe(true);
    expect(result.roleType).toBe('CUSTOMER');
    expect(calls).toBe(1);
    expect(harness.snapshot().committed).toHaveLength(1);
    expect(harness.snapshot().committed[0]?.evidence.domainEvents).toHaveLength(2);
  }),
);

it.effect('exact-equivalent onboarding commits no duplicate domain events', () =>
  Effect.gen(function* exactReplay() {
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      legalEntityPermission: 'allowed',
      services: [
        bindActionTestServices(counterpartyCustomerOnboardAction, {
          onboard: () => Effect.succeed(persistenceResult({ counterpartyCreated: false, rolePeriodCreated: false })),
        }),
      ],
      tenantPermission: 'allowed',
    });

    const result = yield* harness.runtime.runAction(request('exact-1'));

    expect(result.counterpartyCreated).toBe(false);
    expect(result.rolePeriodCreated).toBe(false);
    expect(harness.snapshot().committed[0]?.evidence.domainEvents).toEqual([]);
    expect(harness.snapshot().committed[0]?.evidence.outboxMessages).toEqual([]);
  }),
);
