import { ConfigProvider, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AuthenticationUnavailableProblemSchema,
  AvailableLegalEntitiesResponseSchema,
  AvailableTenantsResponseSchema,
  CurrentSessionSchema,
  ShellCompositionSchema,
  ShellCapabilityUnavailableProblemSchema,
  ShellReloadRequiredProblemSchema,
  TenantAuthenticationRequiredProblemSchema,
  TenantCapabilityUnavailableProblemSchema,
} from '../../../../shared/browser-api.ts';
import { loadHomePageModel } from '../../../../src/routes/[lang]/home-page-model.ts';
import { makeShellBff } from '../../../support/shell-bff-double.ts';
import type { ShellBffScript } from '../../../support/shell-bff-double.ts';

const legalEntityId = '20000000-0000-4000-8000-000000000001';
const tenantId = '30000000-0000-4000-8000-000000000001';
const otherTenantId = '30000000-0000-4000-8000-000000000002';
const identity = {
  displayName: 'Ada Lovelace',
  email: 'ada@example.test',
  legalEntityId,
  legalName: 'Alpha company',
  principalId: 'principal-1',
  tenantId,
};
const compositionRevision = '1'.repeat(64);
const navigation = [
  {
    appId: 'future-generated',
    enabled: true,
    groupKey: 'shell.navigation.modules',
    href: '/modules/future.generated',
    label: 'Future generated',
    moduleId: 'future.generated',
    order: 10,
    state: 'active' as const,
    unavailable: false,
    writable: true,
  },
];
const problem = { detail: 'redacted', title: 'redacted', type: 'about:blank' } as const;
const request = () =>
  new Request('https://shell.example.test/en', {
    headers: { cookie: 'session=test-session' },
  });

const session = Schema.decodeUnknownSync(CurrentSessionSchema);
const legalEntities = Schema.decodeUnknownSync(AvailableLegalEntitiesResponseSchema)({
  legalEntities: [{ legalEntityId, legalName: 'Alpha company' }],
  selectedLegalEntityId: legalEntityId,
  state: 'authenticated',
});
const tenants = Schema.decodeUnknownSync(AvailableTenantsResponseSchema)({
  tenants: [
    { name: 'Alpha tenant', tenantId },
    { name: 'Zeta tenant', tenantId: otherTenantId },
  ],
});
const composition = Schema.decodeUnknownSync(ShellCompositionSchema)({
  compositionRevision,
  navigation,
  state: 'available',
  unavailableDeployments: [],
});

/** The Shell BFF of a signed-in Ada with her Alpha company selected; a test overrides single reads. */
const signedInBff = (overrides: ShellBffScript = {}) =>
  makeShellBff({
    availableLegalEntities: () => Effect.succeed(legalEntities),
    availableTenants: () => Effect.succeed(tenants),
    currentSession: () => Effect.succeed(session({ identity, state: 'authenticated' })),
    shellComposition: () => Effect.succeed(composition),
    ...overrides,
  });

const loadModel = (bff: ReturnType<typeof makeShellBff>, input: Request = request(), configuration = {}) =>
  loadHomePageModel(input).pipe(
    Effect.provide(bff.layer),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(configuration)),
  );
const endpoints = (bff: ReturnType<typeof makeShellBff>) => bff.requests.map((received) => received.endpoint);

it.effect('resolves trusted context before returning one serializable composition', () =>
  Effect.gen(function* verifyCase1() {
    const bff = signedInBff();
    expect(yield* loadModel(bff)).toEqual({
      compositionRevision,
      contextState: 'authenticated',
      identity,
      legalEntities: {
        items: [{ legalEntityId, legalName: 'Alpha company' }],
        state: 'available',
      },
      navigation: {
        items: navigation,
        state: 'available',
        unavailableDeployments: [],
      },
      selectedLegalEntityId: legalEntityId,
      state: 'authenticated',
      tenants: {
        items: [
          { name: 'Alpha tenant', tenantId },
          { name: 'Zeta tenant', tenantId: otherTenantId },
        ],
        state: 'available',
      },
    });
    // The session is read first and the composition before either choice list.
    expect(endpoints(bff).slice(0, 2)).toEqual(['currentSession', 'shellComposition']);
    expect(endpoints(bff).slice(2).toSorted()).toEqual(['availableLegalEntities', 'availableTenants']);
  }),
);

it.effect('does not request composition for an anonymous session', () =>
  Effect.gen(function* verifyCase2() {
    const bff = signedInBff({ currentSession: () => Effect.succeed(session({ state: 'anonymous' })) });
    expect(yield* loadModel(bff)).toEqual({
      state: 'anonymous',
    });
    expect(endpoints(bff)).toEqual(['currentSession']);
  }),
);

it.effect('does not invent a selected legal entity while a tenant session requires selection', () =>
  Effect.gen(function* verifyCase3() {
    const tenantIdentity = {
      displayName: identity.displayName,
      email: identity.email,
      principalId: identity.principalId,
      tenantId: identity.tenantId,
    };
    const bff = signedInBff({
      currentSession: () =>
        Effect.succeed(
          session({
            availableLegalEntities: [{ legalEntityId, legalName: 'Alpha company' }],
            identity: tenantIdentity,
            state: 'selection_required',
          }),
        ),
    });
    const model = yield* loadModel(bff);
    expect(model).toMatchObject({
      contextState: 'selection_required',
      identity: tenantIdentity,
      legalEntities: {
        items: [{ legalEntityId, legalName: 'Alpha company' }],
        state: 'available',
      },
      state: 'authenticated',
    });
    expect(model).not.toHaveProperty('selectedLegalEntityId');
    expect(endpoints(bff)).not.toContain('shellComposition');
    expect(endpoints(bff)).not.toContain('availableLegalEntities');
  }),
);

it.effect('uses the configured HTTPS origin for the server-side session request', () =>
  Effect.gen(function* verifyCase4() {
    const bff = signedInBff({ currentSession: () => Effect.succeed(session({ state: 'anonymous' })) });
    yield* loadModel(bff, new Request('http://shell.stage.example.test/en'), {
      BETTER_AUTH_URL: 'https://shell.stage.example.test',
    });
    expect(bff.requests.at(-1)?.url).toBe('https://shell.stage.example.test/shell-super-app-api/auth/session');
  }),
);

it.effect('keeps the configured local HTTP origin for the server-side session request', () =>
  Effect.gen(function* verifyCase6() {
    const bff = signedInBff({ currentSession: () => Effect.succeed(session({ state: 'anonymous' })) });
    yield* loadModel(bff, new Request('http://localhost:3020/en'), { BETTER_AUTH_URL: 'http://localhost:3020' });
    expect(bff.requests.at(-1)?.url).toBe('http://localhost:3020/shell-super-app-api/auth/session');
  }),
);

it.effect('stops before legal-entity and tenant reads when composition is unavailable', () =>
  Effect.gen(function* verifyCase8() {
    const bff = signedInBff({
      shellComposition: () =>
        Effect.fail(
          Schema.decodeUnknownSync(ShellCapabilityUnavailableProblemSchema)({
            ...problem,
            _tag: 'ShellCapabilityUnavailableProblem',
            retryable: true,
            status: 503,
          }),
        ),
    });
    expect(yield* loadModel(bff)).toEqual({ state: 'unavailable' });
    expect(endpoints(bff)).toEqual(['currentSession', 'shellComposition']);
  }),
);

it.effect('requires a document reload before legal-entity and tenant reads for a stale release', () =>
  Effect.gen(function* staleCompositionStopsOwnerReads() {
    const bff = signedInBff({
      shellComposition: () =>
        Effect.fail(
          Schema.decodeUnknownSync(ShellReloadRequiredProblemSchema)({
            ...problem,
            _tag: 'ShellReloadRequiredProblem',
            status: 409,
          }),
        ),
    });
    expect(yield* loadModel(bff)).toEqual({ state: 'reload_required' });
    expect(endpoints(bff)).toEqual(['currentSession', 'shellComposition']);
  }),
);

const tenantCapabilityUnavailable = () =>
  Effect.fail(
    Schema.decodeUnknownSync(TenantCapabilityUnavailableProblemSchema)({
      ...problem,
      _tag: 'TenantCapabilityUnavailableProblem',
      retryable: true,
      status: 503,
    }),
  );

it.effect('maps tenant failure to the current-tenant fallback without discarding composition', () =>
  Effect.gen(function* verifyCase9() {
    const bff = signedInBff({ availableTenants: tenantCapabilityUnavailable });
    expect(yield* loadModel(bff)).toMatchObject({
      navigation: { items: navigation, state: 'available' },
      tenants: {
        items: [{ name: tenantId, tenantId }],
        state: 'unavailable',
      },
    });
  }),
);

it.effect('keeps legal-entity acquisition failure explicit without claiming choices are available', () =>
  Effect.gen(function* verifyCase10() {
    const bff = signedInBff({ availableLegalEntities: tenantCapabilityUnavailable });
    expect(yield* loadModel(bff)).toMatchObject({
      legalEntities: { items: [], state: 'unavailable' },
      state: 'authenticated',
    });
  }),
);

it.effect('does not collapse an authentication infrastructure failure into an anonymous session', () =>
  Effect.gen(function* verifyCase11() {
    const bff = signedInBff({
      currentSession: () =>
        Effect.fail(
          Schema.decodeUnknownSync(AuthenticationUnavailableProblemSchema)({
            ...problem,
            _tag: 'AuthenticationUnavailableProblem',
            status: 503,
          }),
        ),
    });
    expect(yield* loadModel(bff)).toEqual({
      state: 'unavailable',
    });
  }),
);

it.effect('tears down stale authenticated data when tenant context requires authentication', () =>
  Effect.gen(function* verifyCase12() {
    const bff = signedInBff({
      availableTenants: () =>
        Effect.fail(
          Schema.decodeUnknownSync(TenantAuthenticationRequiredProblemSchema)({
            ...problem,
            _tag: 'TenantAuthenticationRequiredProblem',
            status: 401,
          }),
        ),
    });
    expect(yield* loadModel(bff)).toEqual({
      state: 'anonymous',
    });
  }),
);
