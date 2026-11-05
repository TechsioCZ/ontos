import { ActiveApplicationCompositionService } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import type { executeCounterpartyRead } from '@app/party-registry/api/client';
import {
  CounterpartyReadResponseSchema,
  CounterpartyReadUnavailableProblemSchema,
} from '@app/party-registry/api/client';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { Crypto, DateTime, Effect, Layer, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { ProfilePersistenceDependencyFailure } from '../../src/persistence/profile-persistence.ts';
import type { DelegatedAcquire } from '../support/delegated-gateway-acquisition.fixture.ts';
import { failingDelegatedAcquire, issuedDelegatedContext } from '../support/delegated-gateway-acquisition.fixture.ts';
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

const testCrypto = Crypto.make({
  digest: () => Effect.succeed(new Uint8Array(32)),
  randomBytes: (size) => new Uint8Array(size),
});
const verifiedOperationalScope: OperationalScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '30000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:profile-counterparty-role',
    authMethod: 'session',
    legalEntityId,
    principalId: '60000000-0000-4000-8000-000000000001',
    tenantId,
  }),
  correlationId: 'server-profile-role-read',
  legalEntityId,
};
/** Admission that must never run: the executor-backed reads below do not reach the delegated client. */
const unusedSeams = {
  acquire: () => Effect.die('the delegated admission must not run'),
  crypto: testCrypto,
};

const resolverWith = (execute: CounterpartyReadExecutor) =>
  makeProfileCounterpartyRoleEligibilityResolver(
    {
      legalEntityId,
      operationalScope: verifiedOperationalScope,
      requestCorrelation: 'profile-create:invocation-1',
      tenantId,
    },
    { ...unusedSeams, execute },
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
  const scope = { legalEntityId, tenantId };

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
      operationalScope: verifiedOperationalScope,
      requestCorrelation: 'profile-create:invocation-1',
      tenantId,
    });

    expect(resolver).toBeDefined();
  }).pipe(Effect.provide(profileCounterpartyRoleEligibilityResolverFactoryLive.pipe(Layer.provide(nodeCryptoLayer)))),
);

const serverScope = {
  legalEntityId,
  operationalScope: verifiedOperationalScope,
  requestCorrelation: 'server-profile-role-read',
  tenantId,
};

it.effect('resolves through a delegated Assertion subject and the authorized Party HTTP client', () =>
  Effect.gen(function* serverAuthorizedRead() {
    yield* TestClock.setTime(Date.parse(now));
    const snapshot = yield* makeApplicationCompositionSnapshotFixture();
    const admissions: unknown[] = [];
    const reads: Request[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      reads.push(new Request(input, init));
      return Promise.resolve(Response.json(Schema.encodeSync(CounterpartyReadResponseSchema)(response)));
    };
    const acquire: DelegatedAcquire = (request) => {
      admissions.push(request);
      return Effect.succeed(
        issuedDelegatedContext({
          apiBaseUrl: 'https://shell.example.test/party-registry-api',
          compositionRevision: snapshot.composition.revision,
          token: `fresh-party-assertion-${admissions.length}`,
        }),
      );
    };
    const resolve = makeProfileCounterpartyRoleEligibilityResolver(serverScope, { acquire, crypto: testCrypto });
    expect(globalThis).not.toHaveProperty('document');

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
    });
    expect(admissions).toEqual([
      {
        audience: 'party-registry',
        legalEntityScope: 'subject',
        requestCorrelation: serverScope.requestCorrelation,
        subject: { _tag: 'Assertion', scope: verifiedOperationalScope },
      },
    ]);
    const [read] = reads;
    expect(read?.url).toBe('https://shell.example.test/party-registry-api/reads/counterparty-read');
    expect(read?.headers.get('authorization')).toBe('Bearer fresh-party-assertion-1');
    expect(read?.headers.get('x-api-key')).toBeNull();
    expect(read?.headers.get('x-ontos-composition-revision')).toBe(snapshot.composition.revision);
    expect(read?.headers.get('x-correlation-id')).toBe(serverScope.requestCorrelation);
    expect(yield* Effect.promise(() => read?.json())).toEqual({ counterpartyRef: response.counterpartyRef });
  }),
);

it.effect('fails closed without server composition authority', () =>
  Effect.gen(function* missingServerAuthority() {
    const failure = yield* Effect.flip(
      makeProfileCounterpartyRoleEligibilityResolver(
        serverScope,
        unusedSeams,
      )({
        counterpartyResourceId,
        tenantId,
      }),
    );
    expect(failure).toBeInstanceOf(ProfilePersistenceDependencyFailure);
    expect(failure.reason).toBe('Party Registry Counterparty eligibility is unavailable');
  }),
);

it.effect('fails closed when the delegated admission is refused, before any Party read', () =>
  Effect.gen(function* refusedAdmission() {
    const snapshot = yield* makeApplicationCompositionSnapshotFixture();
    let reads = 0;
    const fakeFetch: typeof fetch = () => {
      reads += 1;
      return Promise.resolve(Response.json({}));
    };
    const failure = yield* makeProfileCounterpartyRoleEligibilityResolver(serverScope, {
      acquire: failingDelegatedAcquire('Shell refused the delegated admission'),
      crypto: testCrypto,
    })({ counterpartyResourceId, tenantId }).pipe(
      Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      Effect.flip,
    );
    expect(failure).toBeInstanceOf(ProfilePersistenceDependencyFailure);
    expect(reads).toBe(0);
  }),
);

it.effect('rejects an expired server composition before requesting any admission', () =>
  Effect.gen(function* expiredServerAuthority() {
    yield* TestClock.setTime(Date.parse(now));
    const snapshot = yield* makeApplicationCompositionSnapshotFixture();
    let admissions = 0;
    let reads = 0;
    const fakeFetch: typeof fetch = () => {
      reads += 1;
      return Promise.resolve(Response.json({}));
    };
    const failure = yield* makeProfileCounterpartyRoleEligibilityResolver(serverScope, {
      acquire: () => {
        admissions += 1;
        return Effect.die('admission must not run for an expired composition');
      },
      crypto: testCrypto,
    })({ counterpartyResourceId, tenantId }).pipe(
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
    expect(admissions).toBe(0);
    expect(reads).toBe(0);
  }),
);

it.effect('rejects a mismatched admitted revision before the Party read', () =>
  Effect.gen(function* mismatchedAdmittedComposition() {
    const snapshot = yield* makeApplicationCompositionSnapshotFixture();
    let admissions = 0;
    let reads = 0;
    const fakeFetch: typeof fetch = () => {
      reads += 1;
      return Promise.resolve(Response.json({}));
    };
    const failure = yield* makeProfileCounterpartyRoleEligibilityResolver(serverScope, {
      acquire: () => {
        admissions += 1;
        return Effect.succeed(
          issuedDelegatedContext({ compositionRevision: 'f'.repeat(64), token: 'wrong-revision-assertion' }),
        );
      },
      crypto: testCrypto,
    })({ counterpartyResourceId, tenantId }).pipe(
      Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      Effect.flip,
    );
    expect(failure).toBeInstanceOf(ProfilePersistenceDependencyFailure);
    expect(admissions).toBe(1);
    expect(reads).toBe(0);
  }),
);

it.effect('preserves a denied public Party read as a dependency failure after admission', () =>
  Effect.gen(function* deniedServerPartyRead() {
    const snapshot = yield* makeApplicationCompositionSnapshotFixture();
    let reads = 0;
    const fakeFetch: typeof fetch = () => {
      reads += 1;
      return Promise.resolve(
        Response.json(
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
    const failure = yield* makeProfileCounterpartyRoleEligibilityResolver(serverScope, {
      acquire: () =>
        Effect.succeed(issuedDelegatedContext({ compositionRevision: snapshot.composition.revision, token: 'fresh' })),
      crypto: testCrypto,
    })({ counterpartyResourceId, tenantId }).pipe(
      Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      Effect.flip,
    );
    expect(failure).toBeInstanceOf(ProfilePersistenceDependencyFailure);
    expect(failure).toHaveProperty('cause.status', 403);
    expect(reads).toBe(1);
  }),
);
