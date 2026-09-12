import type { executeCounterpartyRead } from '@app/party-registry/api/client';
import {
  CounterpartyReadResponseSchema,
  CounterpartyReadUnavailableProblemSchema,
} from '@app/party-registry/api/client';
import { Effect, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { ProfilePersistenceDependencyFailure } from '../../src/persistence/profile-persistence.ts';
import {
  ProfileCounterpartyRoleEligibilityResolverFactory,
  classifyProfileCounterpartyRoleEligibility,
  makeProfileCounterpartyRoleEligibilityResolver,
  profileCounterpartyRoleEligibilityResolverFactoryLive,
} from '../../src/profile-counterparty-role-eligibility.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const counterpartyResourceId = '30000000-0000-4000-8000-000000000001';
const partyResourceId = '40000000-0000-4000-8000-000000000001';
const roleResourceId = '50000000-0000-4000-8000-000000000001';
const now = '2026-09-09T10:00:00.000Z';
const recordedAt = '2026-09-01T08:00:00.000Z';

const response = Schema.decodeUnknownSync(CounterpartyReadResponseSchema)({
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: counterpartyResourceId,
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  createdAt: '2026-08-01T08:00:00.000Z',
  currentRoles: [
    {
      endProvenance: null,
      provenance: {
        evidenceReference: 'party-evidence:customer-onboarding',
        method: 'MANUAL_CONFIRMATION',
        source: 'PARTY_REGISTRY',
      },
      recordedAt,
      rolePeriodRef: {
        moduleId: 'party.registry',
        resourceId: roleResourceId,
        resourceType: 'party.registry.counterparty-role-period',
        tenantId,
      },
      roleType: 'CUSTOMER',
      state: 'ACTIVE',
      validFrom: '2020-01-01T00:00:00.000Z',
      validTo: null,
    },
  ],
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: legalEntityId,
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  party: {
    archived: false,
    canonicalPartyRef: {
      moduleId: 'party.registry',
      resourceId: partyResourceId,
      resourceType: 'party.registry.party',
      tenantId,
    },
    displayName: 'Example Customer',
    partyType: 'ORGANIZATION',
    storedPartyRef: {
      moduleId: 'party.registry',
      resourceId: partyResourceId,
      resourceType: 'party.registry.party',
      tenantId,
    },
  },
});

type CounterpartyReadExecutor = typeof executeCounterpartyRead;

const resolverWith = (execute: CounterpartyReadExecutor) =>
  makeProfileCounterpartyRoleEligibilityResolver(
    { legalEntityId, requestCorrelation: 'profile-create:invocation-1', tenantId },
    execute,
  );

it.effect('accepts one exact Current CUSTOMER role and preserves immutable Party evidence', () =>
  Effect.gen(function* exactCurrentCustomerRole() {
    yield* TestClock.setTime(Date.parse(now));
    let observed:
      | {
          readonly correlation: string;
          readonly request: Parameters<CounterpartyReadExecutor>[0];
        }
      | undefined;
    const execute = ((request, correlation) => {
      observed = { correlation, request };
      return Effect.succeed(response);
    }) satisfies CounterpartyReadExecutor;

    const result = yield* resolverWith(execute)({ counterpartyResourceId, tenantId });

    expect(observed).toEqual({
      correlation: 'profile-create:invocation-1',
      request: {
        counterpartyRef: {
          moduleId: 'party.registry',
          resourceId: counterpartyResourceId,
          resourceType: 'party.registry.counterparty',
          tenantId,
        },
      },
    });
    expect(result).toEqual({
      managedLegalEntityId: legalEntityId,
      outcome: 'ELIGIBLE',
      roleResourceId,
      roleResourceRevision: recordedAt,
    });
  }),
);

it.effect('fails closed when Party Registry returns another managed Legal Entity', () =>
  Effect.gen(function* wrongManagedLegalEntity() {
    const execute = (() =>
      Effect.succeed({
        ...response,
        legalEntityRef: {
          ...response.legalEntityRef,
          resourceId: '20000000-0000-4000-8000-000000000099',
        },
      })) satisfies CounterpartyReadExecutor;

    const result = yield* resolverWith(execute)({ counterpartyResourceId, tenantId });

    expect(result).toEqual({ outcome: 'INELIGIBLE' });
  }),
);

it('uses inclusive validFrom and exclusive validTo Current-time semantics', () => {
  const startsAtBoundary = {
    ...response,
    currentRoles: response.currentRoles.map((role) => ({ ...role, validFrom: now })),
  };
  const endsAtBoundary = {
    ...response,
    currentRoles: response.currentRoles.map((role) => ({ ...role, validTo: now })),
  };
  const scope = { legalEntityId, requestCorrelation: 'correlation', tenantId };

  const active = classifyProfileCounterpartyRoleEligibility(startsAtBoundary, scope, counterpartyResourceId, now);
  const ended = classifyProfileCounterpartyRoleEligibility(endsAtBoundary, scope, counterpartyResourceId, now);

  expect(active.outcome).toBe('ELIGIBLE');
  expect(ended).toEqual({ outcome: 'INELIGIBLE' });
});

it.effect('does not accept an archived Party or a non-CUSTOMER role', () =>
  Effect.gen(function* ineligibleOwnerState() {
    const archived = (() =>
      Effect.succeed({
        ...response,
        party: { ...response.party, archived: true },
      })) satisfies CounterpartyReadExecutor;
    const supplierOnly = (() =>
      Effect.succeed({
        ...response,
        currentRoles: response.currentRoles.map((role) => ({
          ...role,
          roleType: 'SUPPLIER' as const,
        })),
      })) satisfies CounterpartyReadExecutor;

    expect(yield* resolverWith(archived)({ counterpartyResourceId, tenantId })).toEqual({
      outcome: 'INELIGIBLE',
    });
    expect(yield* resolverWith(supplierOnly)({ counterpartyResourceId, tenantId })).toEqual({
      outcome: 'INELIGIBLE',
    });
  }),
);

it.effect('does not choose arbitrarily between overlapping Current CUSTOMER roles', () =>
  Effect.gen(function* ambiguousCurrentRoles() {
    yield* TestClock.setTime(Date.parse(now));
    const execute = (() =>
      Effect.succeed({
        ...response,
        currentRoles: response.currentRoles.flatMap((role) => [
          role,
          {
            ...role,
            recordedAt: '2026-09-02T08:00:00.000Z',
            rolePeriodRef: {
              ...role.rolePeriodRef,
              resourceId: '50000000-0000-4000-8000-000000000099',
            },
          },
        ]),
      })) satisfies CounterpartyReadExecutor;

    const result = yield* resolverWith(execute)({ counterpartyResourceId, tenantId });

    expect(result).toEqual({ outcome: 'INDETERMINATE' });
  }),
);

it.effect('rejects a non-canonical owner evidence version', () =>
  Effect.gen(function* invalidOwnerEvidenceVersion() {
    yield* TestClock.setTime(Date.parse(now));
    const execute = (() =>
      Effect.succeed({
        ...response,
        currentRoles: response.currentRoles.map((role) => ({
          ...role,
          recordedAt: 'not-a-canonical-instant',
        })),
      })) satisfies CounterpartyReadExecutor;

    const result = yield* resolverWith(execute)({ counterpartyResourceId, tenantId });

    expect(result).toEqual({ outcome: 'INDETERMINATE' });
  }),
);

it.effect('maps governed Party Registry failures to the typed persistence dependency error', () =>
  Effect.gen(function* unavailableOwner() {
    const unavailable = Schema.decodeUnknownSync(CounterpartyReadUnavailableProblemSchema)({
      _tag: 'CounterpartyReadUnavailableProblem',
      detail: 'Party Registry unavailable',
      retryable: true,
      status: 503,
      title: 'Unavailable',
      type: 'urn:problem:party-registry-unavailable',
    });
    const execute = (() => Effect.fail(unavailable)) satisfies CounterpartyReadExecutor;

    const failure = yield* Effect.flip(resolverWith(execute)({ counterpartyResourceId, tenantId }));

    expect(failure).toBeInstanceOf(ProfilePersistenceDependencyFailure);
    expect(failure.reason).toBe('Party Registry Counterparty eligibility is unavailable');
  }),
);

it.effect('publishes the production resolver through its contextual factory Layer', () =>
  Effect.gen(function* contextualRoleResolverFactory() {
    const factory = yield* ProfileCounterpartyRoleEligibilityResolverFactory;
    const resolver = factory.make({
      legalEntityId,
      requestCorrelation: 'profile-create:invocation-1',
      tenantId,
    });

    expect(resolver).toBeDefined();
  }).pipe(Effect.provide(profileCounterpartyRoleEligibilityResolverFactoryLive)),
);
