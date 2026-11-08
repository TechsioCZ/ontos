import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  bindActionTestServices,
  makeActionPreparationProbe,
  makeActionTestHarness,
} from '@app/core-runtime/testing/actions';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import {
  attributeGuestRetailCustomerAction,
  bindPreparedGuestParty,
} from '../../src/actions/attribute-guest-retail-customer.action.ts';
import type { PartyRegistryGuestResolverFactoryService } from '../../src/integrations/party-registry-guest-resolver.ts';

import type { GuestPartyResolutionResponse } from '@app/party-registry/api';
import {
  makePartyRegistryGuestResolver,
  PartyRegistryGuestResolverFactory,
  partyRegistryGuestResolverFactoryLive,
} from '../../src/integrations/party-registry-guest-resolver.ts';
import { PartyRegistryRetailPartyResolverFactory } from '../../src/integrations/party-registry-retail-party-resolver.ts';
import { ProfileReactivationEligibilityEvaluatorFactory } from '../../src/integrations/profile-reactivation-eligibility.ts';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from '../../src/profile-counterparty-role-eligibility.ts';
import { ProfilePersistenceDependencyFailure } from '../../src/persistence/profile-persistence.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '20000000-0000-4000-8000-000000000002';
const legalEntityId = '30000000-0000-4000-8000-000000000003';
const partyId = '40000000-0000-4000-8000-000000000004';

const request = {
  correlationRoot: 'guest-correlation',
  guestEvidenceRef: 'opaque-guest-evidence',
  legalEntityId,
  requestedAt: '2026-09-09T10:00:00.000Z',
  tenantId,
} as const;

const scope = {
  legalEntityId,
  requestCorrelation: 'guest-resolution-correlation',
  tenantId,
} as const;

const resolveWith = (response: GuestPartyResolutionResponse) =>
  makePartyRegistryGuestResolver(scope, () => Effect.succeed(response))(request);

it.effect('rejects guest resolution when the request scope crosses Tenant or Legal Entity', () =>
  Effect.flip(
    makePartyRegistryGuestResolver(scope, () =>
      Effect.succeed({
        outcome: 'EXISTING_PARTY_RESOLVED',
        partyRef: {
          moduleId: 'party.registry',
          resourceId: partyId,
          resourceType: 'party.registry.party',
          tenantId,
        },
      } as const),
    )({ ...request, tenantId: otherTenantId }),
  ).pipe(
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(Schema.is(ProfilePersistenceDependencyFailure)(failure)).toBe(true);
        expect(failure.reason).toBe('Guest Party resolution scope is not trusted');
      }),
    ),
  ),
);

it.effect('maps a valid Party owner outcome without making CCC infer identity', () =>
  resolveWith({
    outcome: 'EXISTING_PARTY_RESOLVED',
    partyRef: {
      moduleId: 'party.registry',
      resourceId: partyId,
      resourceType: 'party.registry.party',
      tenantId,
    },
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.outcome).toBe('EXISTING_PARTY_RESOLVED');
        if (result.outcome !== 'EXISTING_PARTY_RESOLVED') {
          throw new Error('Expected an existing Party owner outcome');
        }
        expect(result.partyRef.resourceId).toBe(partyId);
      }),
    ),
  ),
);

it.effect('preserves ambiguous owner evidence as a scoped review case', () => {
  const caseRef = {
    moduleId: 'party.registry' as const,
    resourceId: '50000000-0000-4000-8000-000000000005',
    resourceType: 'party.registry.duplicate-candidate-case' as const,
    tenantId,
  };
  return resolveWith({ caseRef, outcome: 'AMBIGUOUS_MATCH' }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result).toEqual({
          caseRef: caseRef.resourceId,
          outcome: 'AMBIGUOUS_MATCH',
        });
      }),
    ),
  );
});

it.effect('rejects owner Party references from another Tenant before CCC mutation', () =>
  Effect.flip(
    resolveWith({
      outcome: 'EXISTING_PARTY_RESOLVED',
      partyRef: {
        moduleId: 'party.registry',
        resourceId: partyId,
        resourceType: 'party.registry.party',
        tenantId: otherTenantId,
      },
    }),
  ).pipe(
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(Schema.is(ProfilePersistenceDependencyFailure)(failure)).toBe(true);
        expect(failure.reason).toBe('The Party Registry returned a Party outside the trusted Tenant');
      }),
    ),
  ),
);

it.effect('installs the live factory as the production-injectable owner seam', () =>
  Effect.gen(function* verifyLayer() {
    const factory = yield* PartyRegistryGuestResolverFactory;
    expect(Predicate.isFunction(factory.make)).toBe(true);
  }).pipe(Effect.provide(partyRegistryGuestResolverFactoryLive)),
);

it.effect('preserves insufficient Guest identity evidence without synthesizing Party attribution', () =>
  resolveWith({
    outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE',
    reason: 'Contact evidence is not owner identity proof',
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result).toEqual({
          outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE',
          reason: 'Contact evidence is not owner identity proof',
        });
      }),
    ),
  ),
);

it.effect('forwards the exact purchase correlation, evidence, trusted LE and requested instant to the owner', () =>
  makePartyRegistryGuestResolver(scope, (ownerRequest) => {
    expect(ownerRequest.correlationRoot).toBe(request.correlationRoot);
    expect(ownerRequest.guestEvidenceRef).toBe(request.guestEvidenceRef);
    expect(ownerRequest.legalEntityRef).toEqual({
      moduleId: 'core.identity',
      resourceId: legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId,
    });
    return Effect.succeed({ outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE', reason: 'No owner-accepted bound decision' });
  })(request).pipe(Effect.asVoid),
);

it.effect('binds a prepared Party outcome to every Guest evidence selector field', () =>
  Effect.gen(function* exactPreparedSelector() {
    const outcome = { outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE', reason: 'not established' } as const;
    const prepared = bindPreparedGuestParty(request, outcome);
    expect(yield* prepared(request)).toEqual(outcome);
    for (const changed of [
      { ...request, tenantId: otherTenantId },
      { ...request, legalEntityId: otherTenantId },
      { ...request, correlationRoot: 'different-root' },
      { ...request, guestEvidenceRef: 'different-evidence' },
      { ...request, requestedAt: '2026-09-10T10:00:00.000Z' },
    ]) {
      const failure = yield* Effect.flip(prepared(changed));
      expect(failure).toBeInstanceOf(ProfilePersistenceDependencyFailure);
    }
  }),
);

it.effect('runs the original registered Guest preparation with the exact selector before owner execution', () =>
  Effect.gen(function* guestPreflight() {
    const payload = {
      correlationRoot: request.correlationRoot,
      guestEvidenceRef: request.guestEvidenceRef,
      requestedAt: request.requestedAt,
      sellingLegalEntityRef: {
        moduleId: 'core.identity' as const,
        resourceId: legalEntityId,
        resourceType: 'core.identity.legal-entity' as const,
        tenantId,
      },
    };
    const principal = {
      authBindingId: '50000000-0000-4000-8000-000000000005',
      authContextRef: 'better-auth-session:guest-preparation-unit',
      authMethod: 'session' as const,
      legalEntityId,
      principalId: '60000000-0000-4000-8000-000000000006',
      tenantId,
    };
    let calls = 0;
    let executions = 0;
    const probe = makeActionPreparationProbe(attributeGuestRetailCustomerAction);
    const harness = yield* makeActionTestHarness({
      access: 'allowed',
      ownerRegistration: commerceCustomerContextRegistration,
      services: [
        bindActionTestServices(attributeGuestRetailCustomerAction, {
          attribute: () =>
            Effect.sync(() => {
              executions += 1;
              expect(calls).toBe(1);
              return { outcome: 'PARTY_INVALID' as const };
            }),
        }),
      ],
    });
    const crypto = yield* Crypto.Crypto;
    const resolver: PartyRegistryGuestResolverFactoryService = {
      make: (input) => {
        expect(input.crypto).toBe(crypto);
        expect(input.scope).toEqual({ ...principal, correlationId: scope.requestCorrelation });
        expect('evaluatePolicy' in input).toBe(false);
        return (selector) =>
          Effect.sync(() => {
            expect(executions).toBe(0);
            expect(harness.snapshot().transactionCount).toBe(0);
            expect(selector).toEqual(request);
            calls += 1;
            return { outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' as const, reason: 'not established' };
          });
      },
    };
    const run = (candidate: typeof payload, idempotencyKey: string) =>
      harness.runtime.runAction(
        probe.input({
          payload: candidate,
          principal,
          transport: { correlationId: scope.requestCorrelation, idempotencyKey },
        }),
      );
    expect(Option.isNone(probe.snapshot())).toBe(true);
    expect(
      yield* run(payload, 'original-guest-preparation').pipe(
        Effect.provideService(PartyRegistryGuestResolverFactory, resolver),
        Effect.provideService(Crypto.Crypto, crypto),
      ),
    ).toEqual({ outcome: 'PARTY_INVALID' });
    expect(Option.isSome(probe.snapshot())).toBe(true);
    expect(calls).toBe(1);
    expect(executions).toBe(1);
    expect(harness.snapshot().preparationQueries).toEqual([]);
    expect(harness.snapshot().committed).toHaveLength(1);
    const failure = yield* run(
      { ...payload, sellingLegalEntityRef: { ...payload.sellingLegalEntityRef, tenantId: otherTenantId } },
      'foreign-guest-preparation',
    ).pipe(Effect.provideService(PartyRegistryGuestResolverFactory, resolver), Effect.flip);
    expect(failure).toMatchObject({ code: 'CURRENT_STATE_CONFLICT' });
    expect(calls).toBe(1);
    expect(executions).toBe(1);
    const cause = new ProfilePersistenceDependencyFailure({ reason: 'Party unavailable' });
    const unavailable = yield* run(payload, 'unavailable-guest-preparation').pipe(
      Effect.provideService(PartyRegistryGuestResolverFactory, { make: () => () => Effect.fail(cause) }),
      Effect.flip,
    );
    expect(unavailable).toMatchObject({ cause, code: 'PARTY_REGISTRY_UNAVAILABLE', retryable: true });
    expect(executions).toBe(1);
    expect(harness.snapshot().committed).toHaveLength(1);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.succeed(PartyRegistryRetailPartyResolverFactory, {
          make: () => () => Effect.die('Guest preparation must not resolve Retail identity'),
        }),
        Layer.succeed(ProfileCounterpartyRoleEligibilityResolverFactory, {
          make: () => () => Effect.die('Guest preparation must not resolve Counterparty roles'),
        }),
        Layer.succeed(ProfileReactivationEligibilityEvaluatorFactory, {
          make: () => () => Effect.die('Guest preparation must not evaluate reactivation'),
          observe: () => Effect.die('Guest preparation must not observe reactivation'),
        }),
      ),
    ),
  ),
);
