import { ActiveApplicationCompositionService } from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import type { executeCounterpartyRead } from '@app/party-registry/api/client';
import {
  CounterpartyReadResponseSchema,
  CounterpartyReadUnavailableProblemSchema,
} from '@app/party-registry/api/client';
import { ConfigProvider, DateTime, Effect, Result, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { ProfilePersistenceDependencyFailure } from '../../src/persistence/profile-persistence.ts';
import {
  ProfileCounterpartyRoleEligibilityResolverFactory,
  assertPreparedCounterpartyRoleCurrent,
  withPreparedCounterpartyRoleCurrent,
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
      validUntil: null,
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

const serverConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY: 'unit-server-api-key',
    ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
  }),
);
const serverScope = { legalEntityId, requestCorrelation: 'server-profile-role-read', tenantId };

it.effect(
  'resolves in Node without document through fresh Party assertions and the actual authorized HTTP client',
  () =>
    Effect.gen(function* serverAuthorizedRead() {
      yield* TestClock.setTime(Date.parse(now));
      const snapshot = yield* makeApplicationCompositionSnapshotFixture();
      const requests: Request[] = [];
      const fakeFetch: typeof fetch = (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Promise.resolve(
          Response.json(
            requests.length % 2 === 1
              ? {
                  apiBaseUrl: '/party-registry-api',
                  compositionRevision: snapshot.composition.revision,
                  expiresAt: Date.parse(now) / 1000 + 300,
                  token: `fresh-party-assertion-${requests.length}`,
                }
              : Schema.encodeSync(CounterpartyReadResponseSchema)(response),
          ),
        );
      };
      const factory = yield* ProfileCounterpartyRoleEligibilityResolverFactory;
      const resolve = factory.make(serverScope);
      expect(globalThis).not.toHaveProperty('document');
      for (const invocation of [1, 2]) {
        expect(
          yield* resolve({ counterpartyResourceId, tenantId }).pipe(
            Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
            Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
          ),
        ).toEqual({
          managedLegalEntityId: legalEntityId,
          outcome: 'ELIGIBLE',
          roleResourceId,
          roleResourceRevision: recordedAt,
          validUntil: null,
        });
        expect(requests).toHaveLength(invocation * 2);
      }
      for (const index of [0, 2]) {
        const gateway = requests[index];
        const owner = requests[index + 1];
        expect(gateway?.url).toBe('https://shell.example.test/shell-super-app-api/auth/api-key/gateway-context');
        expect(gateway?.headers.get('x-api-key')).toBe('unit-server-api-key');
        expect(gateway?.headers.get('authorization')).toBeNull();
        expect(gateway?.headers.get('cookie')).toBeNull();
        expect(yield* Effect.promise(() => gateway?.json())).toEqual({
          audience: 'party-registry',
          compositionRevision: snapshot.composition.revision,
          legalEntityId,
        });
        expect(owner?.url).toBe('https://shell.example.test/party-registry-api/reads/counterparty-read');
        expect(owner?.headers.get('authorization')).toBe(`Bearer fresh-party-assertion-${index + 1}`);
        expect(owner?.headers.get('x-api-key')).toBeNull();
        expect(owner?.headers.get('x-ontos-composition-revision')).toBe(snapshot.composition.revision);
        expect(owner?.headers.get('x-correlation-id')).toBe(serverScope.requestCorrelation);
        expect(gateway?.headers.get('x-correlation-id')).toBe(serverScope.requestCorrelation);
        expect(yield* Effect.promise(() => owner?.json())).toEqual({ counterpartyRef: response.counterpartyRef });
      }
    }).pipe(Effect.provide(profileCounterpartyRoleEligibilityResolverFactoryLive), Effect.provide(serverConfig)),
);

it.effect('fails closed without server composition authority', () =>
  Effect.gen(function* missingServerAuthority() {
    const failure = yield* Effect.flip(
      makeProfileCounterpartyRoleEligibilityResolver(serverScope)({ counterpartyResourceId, tenantId }),
    );
    expect(failure).toBeInstanceOf(ProfilePersistenceDependencyFailure);
    expect(failure.reason).toBe('Party Registry Counterparty eligibility is unavailable');
  }).pipe(Effect.provide(serverConfig)),
);

it.effect('fails closed without server credential configuration', () =>
  Effect.gen(function* missingServerConfiguration() {
    const snapshot = yield* makeApplicationCompositionSnapshotFixture();
    const failure = yield* makeProfileCounterpartyRoleEligibilityResolver(serverScope)({
      counterpartyResourceId,
      tenantId,
    }).pipe(
      Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
      Effect.flip,
    );
    expect(failure).toBeInstanceOf(ProfilePersistenceDependencyFailure);
  }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
);

it.effect('rejects an expired server composition before requesting any credential', () =>
  Effect.gen(function* expiredServerAuthority() {
    yield* TestClock.setTime(Date.parse(now));
    const snapshot = yield* makeApplicationCompositionSnapshotFixture();
    let requests = 0;
    const fakeFetch: typeof fetch = () => {
      requests += 1;
      return Promise.resolve(Response.json({}));
    };
    const failure = yield* makeProfileCounterpartyRoleEligibilityResolver(serverScope)({
      counterpartyResourceId,
      tenantId,
    }).pipe(
      Effect.provideService(ActiveApplicationCompositionService, {
        load: Effect.succeed({
          ...snapshot,
          observedAt: DateTime.makeUnsafe(Date.parse(now) - 2000),
          validUntil: DateTime.makeUnsafe(Date.parse(now) - 1000),
        }),
      }),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      Effect.flip,
    );
    expect(failure).toBeInstanceOf(ProfilePersistenceDependencyFailure);
    expect(requests).toBe(0);
  }).pipe(Effect.provide(serverConfig)),
);

it.effect('rejects a mismatched issued revision before the Party read', () =>
  Effect.gen(function* mismatchedIssuedComposition() {
    const snapshot = yield* makeApplicationCompositionSnapshotFixture();
    let requests = 0;
    const fakeFetch: typeof fetch = () => {
      requests += 1;
      return Promise.resolve(
        Response.json({
          apiBaseUrl: '/party-registry-api',
          compositionRevision: 'f'.repeat(64),
          expiresAt: 2_000_000_000,
          token: 'wrong-revision-assertion',
        }),
      );
    };
    const failure = yield* makeProfileCounterpartyRoleEligibilityResolver(serverScope)({
      counterpartyResourceId,
      tenantId,
    }).pipe(
      Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      Effect.flip,
    );
    expect(failure).toBeInstanceOf(ProfilePersistenceDependencyFailure);
    expect(requests).toBe(1);
  }).pipe(Effect.provide(serverConfig)),
);

it.effect('preserves a denied public Party read as a dependency failure after server issuance', () =>
  Effect.gen(function* deniedServerPartyRead() {
    const snapshot = yield* makeApplicationCompositionSnapshotFixture();
    let requests = 0;
    const fakeFetch: typeof fetch = () => {
      requests += 1;
      return Promise.resolve(
        requests === 1
          ? Response.json({
              apiBaseUrl: '/party-registry-api',
              compositionRevision: snapshot.composition.revision,
              expiresAt: 2_000_000_000,
              token: 'fresh-assertion',
            })
          : Response.json(
              {
                _tag: 'CounterpartyReadForbiddenProblem',
                detail: 'Forbidden',
                status: 403,
                title: 'Forbidden',
                type: 'urn:test:forbidden',
              },
              { status: 403 },
            ),
      );
    };
    const failure = yield* makeProfileCounterpartyRoleEligibilityResolver(serverScope)({
      counterpartyResourceId,
      tenantId,
    }).pipe(
      Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      Effect.flip,
    );
    expect(failure).toBeInstanceOf(ProfilePersistenceDependencyFailure);
    expect(failure).toHaveProperty('cause.status', 403);
    expect(requests).toBe(2);
  }).pipe(Effect.provide(serverConfig)),
);

it.effect('does not read Party when Shell denies the server credential', () =>
  Effect.gen(function* deniedServerIssuance() {
    const snapshot = yield* makeApplicationCompositionSnapshotFixture();
    let requests = 0;
    const fakeFetch: typeof fetch = () => {
      requests += 1;
      return Promise.resolve(
        Response.json(
          {
            _tag: 'GatewayForbiddenProblem',
            detail: 'Forbidden',
            status: 403,
            title: 'Forbidden',
            type: 'urn:test:forbidden',
          },
          { status: 403 },
        ),
      );
    };
    const failure = yield* makeProfileCounterpartyRoleEligibilityResolver(serverScope)({
      counterpartyResourceId,
      tenantId,
    }).pipe(
      Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      Effect.flip,
    );
    expect(failure).toBeInstanceOf(ProfilePersistenceDependencyFailure);
    expect(failure).toHaveProperty('cause.status', 403);
    expect(requests).toBe(1);
  }).pipe(Effect.provide(serverConfig)),
);

it.effect('retains the actual finite Party role End and fails closed at its exclusive boundary', () =>
  Effect.gen(function* finiteRoleEnd() {
    const end = '2026-09-09T10:00:01.000Z';
    const [originalRole] = response.currentRoles;
    if (originalRole === undefined) {
      return yield* Effect.die('Missing test role');
    }
    const finite = classifyProfileCounterpartyRoleEligibility(
      {
        ...response,
        currentRoles: [{ ...originalRole, validTo: end }],
      },
      { legalEntityId, requestCorrelation: 'finite', tenantId },
      counterpartyResourceId,
      now,
    );
    expect(finite).toMatchObject({ outcome: 'ELIGIBLE', validUntil: end });
    yield* TestClock.setTime(Date.parse(end) - 1);
    yield* assertPreparedCounterpartyRoleCurrent(finite);
    yield* TestClock.setTime(Date.parse(end));
    expect(Result.isFailure(yield* Effect.result(assertPreparedCounterpartyRoleCurrent(finite)))).toBe(true);
    const unknown = {
      managedLegalEntityId: legalEntityId,
      outcome: 'ELIGIBLE' as const,
      roleResourceId,
      roleResourceRevision: recordedAt,
    };
    expect(Result.isFailure(yield* Effect.result(assertPreparedCounterpartyRoleCurrent(unknown)))).toBe(true);
    expect(
      Result.isFailure(
        yield* Effect.result(assertPreparedCounterpartyRoleCurrent({ ...unknown, validUntil: 'invalid' })),
      ),
    ).toBe(true);
    yield* assertPreparedCounterpartyRoleCurrent({ ...unknown, validUntil: null });
    return yield* Effect.void;
  }),
);

it.effect('fails after a write if the observed role reaches its actual End during that write', () =>
  Effect.gen(function* expiryDuringWrite() {
    const end = '2026-09-09T10:00:01.000Z';
    const role = {
      managedLegalEntityId: legalEntityId,
      outcome: 'ELIGIBLE' as const,
      roleResourceId,
      roleResourceRevision: recordedAt,
      validUntil: end,
    };
    yield* TestClock.setTime(Date.parse(end) - 1);
    let wrote = false;
    const result = yield* Effect.result(
      withPreparedCounterpartyRoleCurrent(
        role,
        Effect.gen(function* fakeWrite() {
          wrote = true;
          yield* TestClock.setTime(Date.parse(end));
        }),
      ),
    );
    expect(wrote).toBe(true);
    expect(Result.isFailure(result)).toBe(true);
  }),
);
