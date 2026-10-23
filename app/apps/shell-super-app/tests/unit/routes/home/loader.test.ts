import { ConfigProvider, Effect } from 'effect';
import { beforeEach, expect, rstest, it } from 'effect-rstest';

import * as actualAuthClient from '../../../../src/api/auth-client.ts' with {
  rstest: 'importActual',
};
import { loadHomePageModel, resetBrowserSessionCache } from '../../../../src/routes/[lang]/home-page-model.ts';

const {
  availableLegalEntitiesMock,
  availableTenantsMock,
  browserConfigValuesMock,
  canManageDemoAccountsMock,
  currentSessionMock,
  documentContextMock,
  executeLegalEntityDetailMock,
  issueDocumentGatewayContextsMock,
  resolveModuleTargetMock,
  shellCompositionMock,
} = rstest.hoisted(() => ({
  availableLegalEntitiesMock: rstest.fn(),
  availableTenantsMock: rstest.fn(),
  browserConfigValuesMock: rstest.fn<() => { readonly BETTER_AUTH_URL?: string }>(),
  canManageDemoAccountsMock: rstest.fn(),
  currentSessionMock: rstest.fn(),
  documentContextMock: rstest.fn(),
  executeLegalEntityDetailMock: rstest.fn(),
  issueDocumentGatewayContextsMock: rstest.fn(),
  resolveModuleTargetMock: rstest.fn(),
  shellCompositionMock: rstest.fn(),
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  ...actualAuthClient,
  availableLegalEntities: availableLegalEntitiesMock,
  availableTenants: availableTenantsMock,
  canManageDemoAccounts: canManageDemoAccountsMock,
  currentSession: currentSessionMock,
  documentContext: documentContextMock,
  executeLegalEntityDetail: executeLegalEntityDetailMock,
  issueDocumentGatewayContexts: issueDocumentGatewayContextsMock,
  resolveModuleTarget: resolveModuleTargetMock,
  shellComposition: shellCompositionMock,
}));

const identity = {
  displayName: 'Ada Lovelace',
  email: 'ada@example.test',
  legalEntityId: 'legal-1',
  legalName: 'Alpha company',
  principalId: 'principal-1',
  tenantId: 'tenant-1',
};
const compositionRevision = '1'.repeat(64);
const navigation = [
  {
    appId: 'future-generated',
    enabled: true,
    entrypointKey: 'future.generated.page.records',
    groupKey: 'shell.navigation.unlisted',
    href: '/modules/future.generated',
    icon: 'icon-[mdi--view-grid-outline]',
    label: { cs: 'Budoucí modul', en: 'Future generated' },
    moduleId: 'future.generated',
    order: 10,
    state: 'active' as const,
    unavailable: false,
    writable: true,
  },
];
const request = () =>
  new Request('https://shell.example.test/en', {
    headers: { cookie: 'session=test-session' },
  });

// Each case starts without the browser session memo, so it sees its own session mock.
const loadModel = ({ request: input }: { readonly request: Request }) =>
  Effect.suspend(() =>
    resetBrowserSessionCache.pipe(
      Effect.andThen(loadHomePageModel(input)),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(browserConfigValuesMock())),
    ),
  );
const withBetterAuthUrl = <Value, Failure>(baseUrl: string, operation: () => Effect.Effect<Value, Failure>) =>
  Effect.suspend(() => {
    browserConfigValuesMock.mockReturnValueOnce({ BETTER_AUTH_URL: baseUrl });
    return operation();
  });

beforeEach(() => {
  browserConfigValuesMock.mockReturnValue({});
  canManageDemoAccountsMock.mockReturnValue(Effect.succeed(false));
  resolveModuleTargetMock.mockReturnValue(Effect.fail({ _tag: 'ShellTargetForbiddenProblem' }));
  executeLegalEntityDetailMock.mockReturnValue(Effect.fail({ _tag: 'ShellTargetNotFoundProblem' }));
  currentSessionMock.mockReturnValue(Effect.succeed({ identity, state: 'authenticated' as const }));
  availableLegalEntitiesMock.mockReturnValue(
    Effect.succeed({
      legalEntities: [{ legalEntityId: 'legal-1', legalName: 'Alpha company' }],
      selectedLegalEntityId: 'legal-1',
      state: 'authenticated',
    }),
  );
  shellCompositionMock.mockReturnValue(
    Effect.succeed({
      compositionRevision,
      deniedAppIds: [],
      gatewayAudiences: [],
      homeComponents: [],
      navigation,
      state: 'available' as const,
      unavailableDeployments: [],
    }),
  );
  availableTenantsMock.mockReturnValue(
    Effect.succeed({
      tenants: [
        { name: 'Alpha tenant', tenantId: 'tenant-1' },
        { name: 'Zeta tenant', tenantId: 'tenant-2' },
      ],
    }),
  );
});

it.effect('resolves trusted context before returning one serializable composition', () =>
  Effect.gen(function* verifyCase1() {
    expect(yield* loadModel({ request: request() })).toEqual({
      compositionRevision,
      contextState: 'authenticated',
      gatewayAudiences: [],
      homeContribution: { state: 'forbidden' },
      identity,
      legalEntities: {
        items: [{ legalEntityId: 'legal-1', legalName: 'Alpha company' }],
        state: 'available',
      },
      navigation: {
        deniedAppIds: [],
        items: navigation,
        moduleIds: [...new Set(navigation.map(({ moduleId }) => moduleId))],
        state: 'available',
        unavailableDeployments: [],
      },
      selectedLegalEntityId: 'legal-1',
      state: 'authenticated',
      tenants: {
        items: [
          { name: 'Alpha tenant', tenantId: 'tenant-1' },
          { name: 'Zeta tenant', tenantId: 'tenant-2' },
        ],
        state: 'available',
      },
    });
    expect(currentSessionMock.mock.invocationCallOrder[0]).toBeLessThan(
      shellCompositionMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(shellCompositionMock.mock.invocationCallOrder[0]).toBeLessThan(
      availableLegalEntitiesMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(shellCompositionMock.mock.invocationCallOrder[0]).toBeLessThan(
      availableTenantsMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  }),
);

it.effect('does not request composition for an anonymous session', () =>
  Effect.gen(function* verifyCase2() {
    currentSessionMock.mockReturnValueOnce(Effect.succeed({ state: 'anonymous' as const }));
    expect(yield* loadModel({ request: request() })).toEqual({
      state: 'anonymous',
    });
    expect(shellCompositionMock).not.toHaveBeenCalled();
    expect(availableTenantsMock).not.toHaveBeenCalled();
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
    currentSessionMock.mockReturnValueOnce(
      Effect.succeed({
        availableLegalEntities: [{ legalEntityId: 'legal-1', legalName: 'Alpha company' }],
        identity: tenantIdentity,
        state: 'selection_required' as const,
      }),
    );
    const model = yield* loadModel({ request: request() });
    expect(model).toMatchObject({
      contextState: 'selection_required',
      identity: tenantIdentity,
      legalEntities: {
        items: [{ legalEntityId: 'legal-1', legalName: 'Alpha company' }],
        state: 'available',
      },
      state: 'authenticated',
    });
    expect(model).not.toHaveProperty('selectedLegalEntityId');
    expect(shellCompositionMock).not.toHaveBeenCalled();
    expect(availableLegalEntitiesMock).not.toHaveBeenCalled();
  }),
);

it.effect('uses the configured HTTPS origin for the server-side session request', () =>
  Effect.gen(function* verifyCase4() {
    currentSessionMock.mockReturnValueOnce(Effect.succeed({ state: 'anonymous' as const }));

    yield* withBetterAuthUrl('https://shell.stage.example.test', () =>
      Effect.gen(function* verifyCase5() {
        return yield* loadModel({
          request: new Request('http://shell.stage.example.test/en'),
        });
      }),
    );

    expect(currentSessionMock.mock.calls.at(-1)?.[0]?.baseUrl.toString()).toBe(
      'https://shell.stage.example.test/shell-super-app-api',
    );
  }),
);

it.effect('keeps the configured local HTTP origin for the server-side session request', () =>
  Effect.gen(function* verifyCase6() {
    currentSessionMock.mockReturnValueOnce(Effect.succeed({ state: 'anonymous' as const }));

    yield* withBetterAuthUrl('http://localhost:3020', () =>
      Effect.gen(function* verifyCase7() {
        return yield* loadModel({
          request: new Request('http://localhost:3020/en'),
        });
      }),
    );

    expect(currentSessionMock.mock.calls.at(-1)?.[0]?.baseUrl.toString()).toBe(
      'http://localhost:3020/shell-super-app-api',
    );
  }),
);

it.effect('stops before legal-entity and tenant reads when composition is unavailable', () =>
  Effect.gen(function* verifyCase8() {
    shellCompositionMock.mockReturnValueOnce(Effect.fail({ _tag: 'ShellCapabilityUnavailableProblem' }));
    expect(yield* loadModel({ request: request() })).toEqual({ state: 'unavailable' });
    expect(availableLegalEntitiesMock).not.toHaveBeenCalled();
    expect(availableTenantsMock).not.toHaveBeenCalled();
  }),
);

it.effect('requires a document reload before legal-entity and tenant reads for a stale release', () =>
  Effect.gen(function* staleCompositionStopsOwnerReads() {
    shellCompositionMock.mockReturnValueOnce(Effect.fail({ _tag: 'ShellReloadRequiredProblem' }));
    expect(yield* loadModel({ request: request() })).toEqual({ state: 'reload_required' });
    expect(availableLegalEntitiesMock).not.toHaveBeenCalled();
    expect(availableTenantsMock).not.toHaveBeenCalled();
  }),
);

it.effect('maps tenant failure to the current-tenant fallback without discarding composition', () =>
  Effect.gen(function* verifyCase9() {
    availableTenantsMock.mockReturnValueOnce(Effect.fail({ _tag: 'TenantCapabilityUnavailableProblem' }));
    expect(yield* loadModel({ request: request() })).toMatchObject({
      navigation: { items: navigation, state: 'available' },
      tenants: {
        items: [{ name: 'tenant-1', tenantId: 'tenant-1' }],
        state: 'unavailable',
      },
    });
  }),
);

it.effect('keeps legal-entity acquisition failure explicit without claiming choices are available', () =>
  Effect.gen(function* verifyCase10() {
    availableLegalEntitiesMock.mockReturnValueOnce(Effect.fail({ _tag: 'TenantCapabilityUnavailableProblem' }));
    expect(yield* loadModel({ request: request() })).toMatchObject({
      legalEntities: { items: [], state: 'unavailable' },
      state: 'authenticated',
    });
  }),
);

it.effect('does not collapse an authentication infrastructure failure into an anonymous session', () =>
  Effect.gen(function* verifyCase11() {
    currentSessionMock.mockReturnValueOnce(Effect.fail({ _tag: 'AuthenticationUnavailableProblem' }));
    expect(yield* loadModel({ request: request() })).toEqual({
      state: 'unavailable',
    });
  }),
);

it.effect('tears down stale authenticated data when tenant context requires authentication', () =>
  Effect.gen(function* verifyCase12() {
    availableTenantsMock.mockReturnValueOnce(Effect.fail({ _tag: 'TenantAuthenticationRequiredProblem' }));
    expect(yield* loadModel({ request: request() })).toEqual({
      reason: 'session_ended',
      state: 'anonymous',
    });
  }),
);

it.effect('sends a disabled account to sign-in instead of the unavailable state (S00)', () =>
  Effect.gen(function* verifyDisabledAccount() {
    currentSessionMock.mockReturnValueOnce(Effect.fail({ _tag: 'OntosIdentityForbiddenProblem' }));
    expect(yield* loadModel({ request: request() })).toEqual({ reason: 'account_forbidden', state: 'anonymous' });
  }),
);

it.effect('reuses one authenticated browser session across loaders and rereads after an anonymous answer', () =>
  Effect.gen(function* verifySessionMemo() {
    yield* resetBrowserSessionCache;
    const load = loadHomePageModel(new Request('https://shell.example.test/en')).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
    );
    yield* Effect.all([load, load, load], { concurrency: 'unbounded' });
    expect(currentSessionMock).toHaveBeenCalledTimes(1);

    yield* resetBrowserSessionCache;
    currentSessionMock.mockReturnValue(Effect.succeed({ state: 'anonymous' as const }));
    yield* load;
    yield* load;
    expect(currentSessionMock).toHaveBeenCalledTimes(3);
  }),
);

it.effect('shares one composition, tenant and legal-entity read across concurrent browser loaders', () =>
  Effect.gen(function* verifyContextMemo() {
    yield* resetBrowserSessionCache;
    const load = loadHomePageModel(new Request('https://shell.example.test/en')).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
    );
    yield* Effect.all([load, load, load], { concurrency: 'unbounded' });
    expect(shellCompositionMock).toHaveBeenCalledTimes(1);
    expect(availableTenantsMock).toHaveBeenCalledTimes(1);
    expect(availableLegalEntitiesMock).toHaveBeenCalledTimes(1);

    yield* resetBrowserSessionCache;
    availableTenantsMock.mockReturnValueOnce(Effect.fail({ _tag: 'TenantInternalProblem' }));
    yield* load;
    yield* load;
    expect(availableTenantsMock).toHaveBeenCalledTimes(3);
  }),
);

it.effect('rechecks Home contribution permissions on every visit even when navigation composition is reused', () =>
  Effect.gen(function* freshHomeContributionPermission() {
    shellCompositionMock.mockReturnValue(
      Effect.succeed({
        compositionRevision,
        deniedAppIds: [],
        gatewayAudiences: [],
        homeComponents: [
          {
            entrypointKey: 'fixture.summary.component.home',
            moduleId: 'fixture.summary',
            order: 100,
            requiresModules: ['fixture.summary', 'fixture.unlisted'],
          },
          {
            entrypointKey: 'fixture.dashboard.component.home',
            moduleId: 'fixture.dashboard',
            order: 200,
            requiresModules: ['fixture.dashboard', 'fixture.sales', 'fixture.tasks'],
          },
        ],
        navigation: ['fixture.dashboard', 'fixture.sales', 'fixture.tasks'].map((moduleId) => ({
          ...navigation[0],
          moduleId,
        })),
        state: 'available',
        unavailableDeployments: [],
      }),
    );
    yield* loadModel({ request: request() });
    yield* loadHomePageModel(request());
    expect(resolveModuleTargetMock).toHaveBeenCalledTimes(2);
    expect(resolveModuleTargetMock.mock.calls[0]?.[0]).toEqual({
      compositionRevision,
      entrypointKey: 'fixture.dashboard.component.home',
      moduleId: 'fixture.dashboard',
    });
    resolveModuleTargetMock.mockReturnValueOnce(Effect.fail({ _tag: 'ShellCapabilityUnavailableProblem' }));
    expect(yield* loadHomePageModel(request())).toMatchObject({ homeContribution: { state: 'unavailable' } });
  }),
);

it.effect('does not resolve the Home component from anonymous, selection-required or non-Home routes', () =>
  Effect.gen(function* homeContributionContextGate() {
    yield* loadModel({ request: new Request('https://shell.example.test/en/ukoly') });
    expect(resolveModuleTargetMock).not.toHaveBeenCalled();
    currentSessionMock.mockReturnValueOnce(Effect.succeed({ state: 'anonymous' }));
    yield* loadModel({ request: request() });
    expect(resolveModuleTargetMock).not.toHaveBeenCalled();
  }),
);

it.effect.each([false, true])(
  'offers people administration only after a successful server capability check (%s)',
  (allowed) =>
    Effect.gen(function* peopleNavigationCapability() {
      shellCompositionMock.mockReturnValue(
        Effect.succeed({
          compositionRevision,
          deniedAppIds: [],
          gatewayAudiences: [],
          homeComponents: [],
          navigation: [
            { ...navigation[0], href: '/fixture/people', requiresCapability: 'people_administration' },
            { ...navigation[0], href: '/fixture/clients' },
          ],
          state: 'available',
          unavailableDeployments: [],
        }),
      );
      canManageDemoAccountsMock.mockReturnValue(Effect.succeed(allowed));
      const model = yield* loadModel({ request: request() });
      expect(model).toMatchObject({
        navigation: {
          deniedAppIds: [],
          items: allowed
            ? [
                expect.objectContaining({ href: '/fixture/people' }),
                expect.objectContaining({ href: '/fixture/clients' }),
                expect.objectContaining({ href: '/sprava/ke-schvaleni' }),
                expect.objectContaining({ href: '/sprava/aktivita-agentu' }),
                expect.objectContaining({ href: '/sprava/pripojene-aplikace' }),
              ]
            : [expect.objectContaining({ href: '/fixture/clients' })],
        },
      });
      expect(canManageDemoAccountsMock).toHaveBeenCalledTimes(1);
    }),
);

it.effect('shows the welcome text the selected company provides on the Shell welcome page', () =>
  Effect.gen(function* companyWelcome() {
    executeLegalEntityDetailMock.mockReturnValueOnce(
      Effect.succeed({ legalName: 'Alpha company', status: 'active', welcome: 'Bread and pastry for the whole town.' }),
    );
    expect(yield* loadModel({ request: request() })).toMatchObject({
      companyWelcome: 'Bread and pastry for the whole town.',
      homeContribution: { state: 'forbidden' },
    });
    expect(executeLegalEntityDetailMock.mock.calls.at(-1)?.[0]).toEqual({
      legalEntityRef: {
        moduleId: 'core.identity',
        resourceId: 'legal-1',
        resourceType: 'core.identity.legal-entity',
        tenantId: 'tenant-1',
      },
    });
  }),
);

/** Server rendering: no browser document, like the SSR loader on Node and Workers. */
const asServerRender = <Value, Failure>(operation: Effect.Effect<Value, Failure>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
      Reflect.deleteProperty(globalThis, 'document');
      return descriptor;
    }),
    () => operation,
    (descriptor) =>
      Effect.sync(() => {
        if (descriptor !== undefined) {
          Object.defineProperty(globalThis, 'document', descriptor);
        }
      }),
  );
// happy-dom's Request drops the cookie header (a browser-forbidden name); the server's request carries it.
const serverRequest = (url = 'https://shell.example.test/en') => {
  const cookie = 'better-auth.session_token=test-session';
  const headers = Object.assign(new Headers(), {
    get: (name: string) => (name.toLowerCase() === 'cookie' ? cookie : null),
  });
  return Object.defineProperty(new Request(url), 'headers', { value: headers });
};

const availableComposition = <Overrides extends object>(overrides: Overrides) => ({
  compositionRevision,
  deniedAppIds: [],
  gatewayAudiences: [],
  homeComponents: [],
  navigation,
  state: 'available' as const,
  unavailableDeployments: [],
  ...overrides,
});

const documentContextOf = <Overrides extends object>(overrides: Overrides) => ({
  canManagePeople: false,
  composition: availableComposition({}),
  home: { contribution: { state: 'forbidden' as const } },
  legalEntities: {
    legalEntities: [{ legalEntityId: 'legal-1', legalName: 'Alpha company' }],
    selectedLegalEntityId: 'legal-1',
    state: 'authenticated',
  },
  session: { identity, state: 'authenticated' as const },
  tenants: { state: 'available', tenants: [{ name: 'Alpha tenant', tenantId: 'tenant-1' }] },
  ...overrides,
});

const withoutLegalEntities = <Context extends { readonly legalEntities: unknown }>({
  legalEntities: _legalEntities,
  ...rest
}: Context) => rest;

const serverModel = (url?: string) => asServerRender(loadModel({ request: serverRequest(url) }));

it.effect('server rendering reads the whole document context in one request', () =>
  Effect.gen(function* serverReadsOnce() {
    documentContextMock.mockReturnValue(Effect.succeed(documentContextOf({})));
    expect(yield* serverModel()).toEqual({
      compositionRevision,
      contextState: 'authenticated',
      gatewayAudiences: [],
      homeContribution: { state: 'forbidden' },
      identity,
      legalEntities: { items: [{ legalEntityId: 'legal-1', legalName: 'Alpha company' }], state: 'available' },
      navigation: {
        deniedAppIds: [],
        items: navigation,
        moduleIds: ['future.generated'],
        state: 'available',
        unavailableDeployments: [],
      },
      selectedLegalEntityId: 'legal-1',
      state: 'authenticated',
      tenants: { items: [{ name: 'Alpha tenant', tenantId: 'tenant-1' }], state: 'available' },
    });
    expect(documentContextMock).toHaveBeenCalledTimes(1);
    expect(documentContextMock.mock.calls[0]?.[0]).toEqual({ home: true });
    for (const separateRead of [
      currentSessionMock,
      shellCompositionMock,
      availableTenantsMock,
      availableLegalEntitiesMock,
      canManageDemoAccountsMock,
      issueDocumentGatewayContextsMock,
      resolveModuleTargetMock,
    ]) {
      expect(separateRead).not.toHaveBeenCalled();
    }
  }),
);

it.effect('server rendering maps each document-context part to the same models as the separate reads', () =>
  Effect.gen(function* serverPartOutcomes() {
    documentContextMock.mockReturnValueOnce(Effect.succeed({ session: { state: 'anonymous' } }));
    expect(yield* serverModel()).toEqual({ state: 'anonymous' });
    documentContextMock.mockReturnValueOnce(
      Effect.succeed(documentContextOf({ composition: { state: 'reload_required' } })),
    );
    expect(yield* serverModel()).toEqual({ state: 'reload_required' });
    documentContextMock.mockReturnValueOnce(
      Effect.succeed(documentContextOf({ composition: { state: 'unavailable' } })),
    );
    expect(yield* serverModel()).toEqual({ state: 'unavailable' });
    documentContextMock.mockReturnValueOnce(
      Effect.succeed(documentContextOf({ tenants: { state: 'authentication_required' } })),
    );
    expect(yield* serverModel()).toEqual({ reason: 'session_ended', state: 'anonymous' });
    documentContextMock.mockReturnValueOnce(
      Effect.succeed(withoutLegalEntities(documentContextOf({ tenants: { state: 'unavailable' } }))),
    );
    expect(yield* serverModel()).toMatchObject({
      legalEntities: { items: [], state: 'unavailable' },
      tenants: { items: [{ name: 'tenant-1', tenantId: 'tenant-1' }], state: 'unavailable' },
    });
    documentContextMock.mockReturnValueOnce(Effect.fail({ _tag: 'OntosIdentityForbiddenProblem' }));
    expect(yield* serverModel()).toEqual({ reason: 'account_forbidden', state: 'anonymous' });
  }),
);

it.effect('server rendering keeps a context without a selected legal entity free of composition data', () =>
  Effect.gen(function* serverSelectionRequired() {
    documentContextMock.mockReturnValueOnce(
      Effect.succeed({
        composition: { navigation: [], state: 'selection_required' },
        legalEntities: { legalEntities: [], state: 'selection_required' },
        session: {
          availableLegalEntities: [{ legalEntityId: 'legal-2', legalName: 'Beta company' }],
          identity: {
            displayName: 'Ada Lovelace',
            email: 'ada@example.test',
            principalId: 'principal-1',
            tenantId: 'tenant-1',
          },
          state: 'selection_required',
        },
        tenants: { state: 'available', tenants: [{ name: 'Alpha tenant', tenantId: 'tenant-1' }] },
      }),
    );
    const model = yield* serverModel();
    expect(model).toMatchObject({
      contextState: 'selection_required',
      legalEntities: { items: [{ legalEntityId: 'legal-2', legalName: 'Beta company' }], state: 'available' },
      navigation: { items: [], state: 'available' },
    });
    expect(model).not.toHaveProperty('compositionRevision');
  }),
);

it.effect('server rendering offers people administration from the context capability', () =>
  Effect.gen(function* serverPeopleCapability() {
    const peopleNavigation = [
      { ...navigation[0], href: '/fixture/people', requiresCapability: 'people_administration' },
      { ...navigation[0], href: '/fixture/clients' },
    ];
    for (const canManagePeople of [false, true]) {
      documentContextMock.mockReturnValueOnce(
        Effect.succeed(
          documentContextOf({ canManagePeople, composition: availableComposition({ navigation: peopleNavigation }) }),
        ),
      );
      const model = yield* serverModel();
      expect(model).toMatchObject({
        navigation: {
          items: canManagePeople
            ? [
                expect.objectContaining({ href: '/fixture/people' }),
                expect.objectContaining({ href: '/fixture/clients' }),
                expect.objectContaining({ href: '/sprava/ke-schvaleni' }),
                expect.objectContaining({ href: '/sprava/aktivita-agentu' }),
                expect.objectContaining({ href: '/sprava/pripojene-aplikace' }),
              ]
            : [expect.objectContaining({ href: '/fixture/clients' })],
        },
      });
    }
  }),
);

it.effect('server rendering embeds the admitted Home target without a separate request', () =>
  Effect.gen(function* serverAdmitsHome() {
    const contribution = {
      state: 'ready' as const,
      target: { compositionRevision, moduleId: 'fixture.dashboard' },
    };
    documentContextMock.mockReturnValue(Effect.succeed(documentContextOf({ home: { contribution } })));
    expect(yield* serverModel()).toMatchObject({ homeContribution: contribution, state: 'authenticated' });
    expect(resolveModuleTargetMock).not.toHaveBeenCalled();
    expect(executeLegalEntityDetailMock).not.toHaveBeenCalled();
    yield* serverModel('https://shell.example.test/en/ukoly');
    expect(documentContextMock.mock.calls.at(-1)?.[0]).toEqual({});
  }),
);

it.effect('server rendering preserves the company welcome and unavailable Home outcomes', () =>
  Effect.gen(function* serverHomeOutcomes() {
    documentContextMock.mockReturnValueOnce(
      Effect.succeed(
        documentContextOf({
          home: { contribution: { state: 'forbidden' }, welcome: 'Firemní přivítání' },
        }),
      ),
    );
    expect(yield* serverModel()).toMatchObject({
      companyWelcome: 'Firemní přivítání',
      homeContribution: { state: 'forbidden' },
    });
    documentContextMock.mockReturnValueOnce(
      Effect.succeed(
        documentContextOf({
          home: { contribution: { state: 'unavailable' } },
        }),
      ),
    );
    expect(yield* serverModel()).toMatchObject({ homeContribution: { state: 'unavailable' } });
    expect(executeLegalEntityDetailMock).not.toHaveBeenCalled();
  }),
);

const gatewayAssertion = {
  apiBaseUrl: '/shell-super-app-api/module-api/future-generated/build/future-generated-api',
  audience: 'future-generated',
  compositionRevision,
  expiresAt: 1_700_000_300,
  token: 'assertion-token',
};

const audienceComposition = () => availableComposition({ gatewayAudiences: ['future-generated'] });

const withGatewayAudiences = () =>
  documentContextMock.mockReturnValue(Effect.succeed(documentContextOf({ composition: audienceComposition() })));

const withSignedGatewayAssertions = () =>
  documentContextMock.mockReturnValue(
    Effect.succeed(documentContextOf({ composition: audienceComposition(), gatewayAssertions: [gatewayAssertion] })),
  );

it.effect('server rendering embeds the gateway assertions the document context signed, with no second call', () =>
  Effect.gen(function* serverEmbedsAssertions() {
    withSignedGatewayAssertions();
    expect(yield* serverModel('https://shell.example.test/en/ukoly')).toMatchObject({
      gatewayAssertions: [gatewayAssertion],
      gatewayAudiences: ['future-generated'],
    });
    expect(documentContextMock).toHaveBeenCalledTimes(1);
    expect(issueDocumentGatewayContextsMock).not.toHaveBeenCalled();
  }),
);

it.effect('server rendering without signed assertions leaves them to the browser batch', () =>
  Effect.gen(function* serverWithoutAssertions() {
    withGatewayAudiences();
    const model = yield* serverModel('https://shell.example.test/en/ukoly');
    expect(model).toMatchObject({ gatewayAudiences: ['future-generated'], state: 'authenticated' });
    expect(model).not.toHaveProperty('gatewayAssertions');
    expect(issueDocumentGatewayContextsMock).not.toHaveBeenCalled();
  }),
);
