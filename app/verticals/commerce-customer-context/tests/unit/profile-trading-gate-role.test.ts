import { NodeCrypto } from '@effect/platform-node';
import { PartyRegistryGuestResolverFactory } from '../../src/integrations/party-registry-guest-resolver.ts';
import { PartyRegistryRetailPartyResolverFactory } from '../../src/integrations/party-registry-retail-party-resolver.ts';
import { ProfileReactivationEligibilityEvaluatorFactory } from '../../src/integrations/profile-reactivation-eligibility.ts';
import { Effect, Layer, Result, Schema } from 'effect';
import {
  ReadHandlerUnavailable,
  TrustedPrincipalContextSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import { TestClock } from 'effect/testing';
import { runReadOwnerSteps } from '../../../../packages/core-runtime/src/reads/definition.ts';
import { expect, it } from 'effect-rstest';

import type {
  CounterpartyRoleEligibility,
  ProfilePersistenceScope,
  ProfileScopedRoutineInvoker,
} from '../../src/persistence/profile-persistence.ts';
import { customerProfileTradingGateRead } from '../../src/api/customer-profile-trading-gate.read.ts';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from '../../src/profile-counterparty-role-eligibility.ts';
import type { ProfileCounterpartyRoleEligibilityScope } from '../../src/profile-counterparty-role-eligibility.ts';
import { profilePersistenceServicesForTransaction } from '../../src/persistence/profile-persistence.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const otherLegalEntityId = '20000000-0000-4000-8000-000000000099';
const principalId = '30000000-0000-4000-8000-000000000003';
const profileId = '40000000-0000-4000-8000-000000000004';
const counterpartyId = '50000000-0000-4000-8000-000000000005';
const roleId = '60000000-0000-4000-8000-000000000006';

const scope: ProfilePersistenceScope = { legalEntityId, principalId, tenantId };
const request = {
  authorizationSubject: {
    counterpartyRef: {
      moduleId: 'party.registry' as const,
      resourceId: counterpartyId,
      resourceType: 'party.registry.counterparty' as const,
      tenantId,
    },
    kind: 'COUNTERPARTY' as const,
  },
  profileRef: {
    kind: 'COUNTERPARTY' as const,
    moduleId: 'commerce.customer-context' as const,
    resourceId: profileId,
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
    tenantId,
  },
};

const tradingRows = [
  {
    outcome: 'PROFILE_AVAILABLE',
    payload: {
      createdAt: '2026-09-09T09:00:00.000Z',
      profileId,
      profileKind: 'COUNTERPARTY',
      revision: 3,
      scopeLegalEntityId: legalEntityId,
      state: 'ACTIVE',
      subject: {
        counterpartyResourceId: counterpartyId,
        counterpartyResourceRevision: 'counterparty:7',
        customerRoleResourceId: roleId,
        customerRoleResourceRevision: '2026-09-09T08:00:00.000Z',
        kind: 'COUNTERPARTY',
      },
      updatedAt: '2026-09-09T09:00:00.000Z',
    },
  },
];

const transaction: ProfileScopedRoutineInvoker = { invoke: () => Effect.succeed(tradingRows) };

const normalizedStatement = (statement: string) => statement.trim().toLowerCase();

const observedRoleFactory = (
  snapshot: () => { readonly statements: readonly string[] },
  prepared: () => void,
  managedLegalEntityId: string,
  observedAt: string,
  validUntil: string,
) => ({
  make: (roleScope: ProfileCounterpartyRoleEligibilityScope) => () =>
    Effect.sync(() => {
      const statements = snapshot().statements.map(normalizedStatement);
      expect(statements.lastIndexOf('begin')).toBeLessThanOrEqual(
        Math.max(statements.lastIndexOf('commit'), statements.lastIndexOf('rollback')),
      );
      expect(roleScope.operationalScope.principalId).toBe(principalId);
      prepared();
      return {
        managedLegalEntityId,
        observedAt,
        outcome: 'ELIGIBLE' as const,
        roleResourceId: roleId,
        roleResourceRevision: observedAt,
        validUntil,
      };
    }),
});

const gateWith = (eligibility: CounterpartyRoleEligibility) =>
  profilePersistenceServicesForTransaction(transaction, scope, {
    resolveCounterpartyRole: () => Effect.succeed(eligibility),
  }).customerProfileTradingGate.evaluateGate(request, tenantId);

it.effect('requires a current seller-matching CUSTOMER Role in addition to Active lifecycle', () =>
  gateWith({
    managedLegalEntityId: legalEntityId,
    outcome: 'ELIGIBLE',
    roleResourceId: roleId,
    roleResourceRevision: '2026-09-09T10:00:00.000Z',
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.gate).toEqual({ canAcceptNewOrder: true, outcome: 'ACTIVE' });
        expect(result.provenance[1]).toMatchObject({
          freshness: {
            revision: '2026-09-09T10:00:00.000Z',
            sourceModuleId: 'party.registry',
            status: 'CURRENT',
          },
          projection: 'PARTY_REGISTRY',
          sourceResourceRef: roleId,
        });
      }),
    ),
  ),
);

it.effect('denies a non-eligible Role instead of treating global profile uniqueness as role denial', () =>
  gateWith({ outcome: 'INELIGIBLE' }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.gate).toEqual({
          canAcceptNewOrder: false,
          outcome: 'COUNTERPARTY_ROLE_NOT_ELIGIBLE',
        });
        expect(result.provenance[1]).toMatchObject({
          freshness: { sourceModuleId: 'party.registry', status: 'CURRENT' },
          projection: 'PARTY_REGISTRY',
        });
        expect(result.provenance[1]).not.toHaveProperty('sourceResourceRef');
      }),
    ),
  ),
);

it.effect('fails closed when an eligible Role belongs to another seller', () =>
  gateWith({
    managedLegalEntityId: otherLegalEntityId,
    outcome: 'ELIGIBLE',
    roleResourceId: roleId,
    roleResourceRevision: '2026-09-09T10:00:00.000Z',
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.gate).toEqual({
          canAcceptNewOrder: false,
          outcome: 'COUNTERPARTY_ROLE_NOT_ELIGIBLE',
        });
        expect(result.provenance[1]).toMatchObject({
          freshness: {
            sourceModuleId: 'party.registry',
            status: 'INDETERMINATE',
          },
          projection: 'PARTY_REGISTRY',
          sourceResourceRef: roleId,
        });
      }),
    ),
  ),
);

it.effect('rejects a prepared role that reaches its End during the trading-gate read', () =>
  Effect.gen(function* roleExpiresDuringRead() {
    const end = '2026-09-09T10:00:01.000Z';
    const role = {
      managedLegalEntityId: legalEntityId,
      observedAt: '2026-09-09T10:00:00.000Z',
      outcome: 'ELIGIBLE' as const,
      roleResourceId: roleId,
      roleResourceRevision: '2026-09-09T10:00:00.000Z',
      validUntil: end,
    };
    yield* TestClock.setTime(Date.parse(end) - 1);
    const result = yield* runReadOwnerSteps(customerProfileTradingGateRead, request, {
      readKey: customerProfileTradingGateRead.descriptor.readKey,
      scope: { ...scope, authMethod: 'system', correlationId: 'trading-gate-expiry' },
      services: {
        evaluateGate: () => gateWith(role).pipe(Effect.tap(() => TestClock.setTime(Date.parse(end)))),
      },
    }).pipe(
      Effect.provideService(ProfileCounterpartyRoleEligibilityResolverFactory, {
        make: () => () => Effect.succeed(role),
      }),
      Effect.result,
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Schema.is(ReadHandlerUnavailable)(result.failure)).toBe(true);
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        TestClock.layer(),
        NodeCrypto.layer,
        Layer.succeed(PartyRegistryGuestResolverFactory, {
          make: () => () => Effect.die('Trading gate must not resolve a Guest Party'),
        }),
        Layer.succeed(PartyRegistryRetailPartyResolverFactory, {
          make: () => () => Effect.die('Trading gate must not resolve a Retail Party'),
        }),
        Layer.succeed(ProfileReactivationEligibilityEvaluatorFactory, {
          make: () => () => Effect.die('Trading gate must not reactivate a profile'),
          observe: () => Effect.die('Trading gate must not prepare a profile reactivation'),
        }),
      ),
    ),
  ),
);

it.effect(
  'runs the original trading registration with released Party preparation and bounded current-role evidence',
  () =>
    Effect.gen(function* nativeTradingRoleLifecycle() {
      const observedAt = '2026-09-09T10:00:00.000Z';
      const validUntil = '2026-09-09T10:00:01.000Z';
      const principal = trustVerifiedGatewayPrincipalContext(
        Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
          authBindingId: '70000000-0000-4000-8000-000000000001',
          authContextRef: 'session:trading-role',
          authMethod: 'session',
          legalEntityId,
          principalId,
          tenantId,
        }),
        'a'.repeat(64),
      );
      yield* Effect.forEach(
        ['CURRENT', 'GATE_DENIED', 'EXPIRED_DURING_LOAD', 'FOREIGN_COMPANY'] as const,
        Effect.fnUntraced(function* roleCase(scenario) {
          yield* TestClock.setTime(Date.parse(observedAt));
          let preparations = 0;
          let ownerLoads = 0;
          const harness = yield* makeReadTestHarness({
            access: scenario === 'GATE_DENIED' ? 'denied' : 'allowed',
            compositionRevision: 'a'.repeat(64),
            executeOwnerQuery: ({ sql }) => {
              if (!sql.includes('read_profile_trading_gate')) {
                return Effect.die(`Unexpected trading owner query: ${sql}`);
              }
              ownerLoads += 1;
              return Effect.succeed(tradingRows).pipe(
                Effect.tap(() =>
                  scenario === 'EXPIRED_DURING_LOAD' ? TestClock.setTime(Date.parse(validUntil)) : Effect.void,
                ),
              );
            },
            operationTime: new Date(observedAt),
            ownerAuthorizationDecision: 'allowed',
            ownerRegistration: commerceCustomerContextRegistration,
            scope: { ...principal, correlationId: 'trading-native' },
          });
          const result = yield* harness.runtime
            .runRead({
              input: request,
              principal,
              registration: customerProfileTradingGateRead,
              transport: { correlationId: 'trading-native' },
            })
            .pipe(
              Effect.provideService(
                ProfileCounterpartyRoleEligibilityResolverFactory,
                observedRoleFactory(
                  harness.snapshot,
                  () => {
                    preparations += 1;
                  },
                  scenario === 'FOREIGN_COMPANY' ? otherLegalEntityId : legalEntityId,
                  observedAt,
                  validUntil,
                ),
              ),
              Effect.result,
            );
          expect(Result.isSuccess(result)).toBe(scenario === 'CURRENT' || scenario === 'FOREIGN_COMPANY');
          expect(preparations).toBe(scenario === 'GATE_DENIED' ? 0 : 1);
          expect(ownerLoads).toBe(scenario === 'GATE_DENIED' ? 0 : 1);
          if (Result.isSuccess(result)) {
            expect(result.success.gate.canAcceptNewOrder).toBe(scenario === 'CURRENT');
          }
        }),
        { concurrency: 1, discard: true },
      );
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(NodeCrypto.layer)),
);
