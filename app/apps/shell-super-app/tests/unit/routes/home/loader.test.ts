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
  currentSessionMock,
  resolveModuleTargetMock,
  shellCompositionMock,
} = rstest.hoisted(() => ({
  availableLegalEntitiesMock: rstest.fn(),
  availableTenantsMock: rstest.fn(),
  browserConfigValuesMock: rstest.fn<() => { readonly BETTER_AUTH_URL?: string }>(),
  currentSessionMock: rstest.fn(),
  resolveModuleTargetMock: rstest.fn(),
  shellCompositionMock: rstest.fn(),
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  ...actualAuthClient,
  availableLegalEntities: availableLegalEntitiesMock,
  availableTenants: availableTenantsMock,
  currentSession: currentSessionMock,
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
  resolveModuleTargetMock.mockReturnValue(Effect.fail({ _tag: 'ShellTargetForbiddenProblem' }));
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
      homeContribution: { state: 'forbidden' },
      identity,
      legalEntities: {
        items: [{ legalEntityId: 'legal-1', legalName: 'Alpha company' }],
        state: 'available',
      },
      navigation: {
        items: navigation,
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
      state: 'anonymous',
    });
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
    yield* loadModel({ request: request() });
    yield* loadHomePageModel(request());
    expect(resolveModuleTargetMock).toHaveBeenCalledTimes(2);
    expect(resolveModuleTargetMock.mock.calls[0]?.[0]).toEqual({
      compositionRevision,
      entrypointKey: 'demo.sales-insights.component.crm-dashboard',
      moduleId: 'demo.sales-insights',
    });
    resolveModuleTargetMock.mockReturnValueOnce(Effect.fail({ _tag: 'ShellCapabilityUnavailableProblem' }));
    expect(yield* loadHomePageModel(request())).toMatchObject({ homeContribution: { state: 'unavailable' } });
  }),
);

it.effect('does not resolve the Home component from anonymous, selection-required or non-Home routes', () =>
  Effect.gen(function* homeContributionContextGate() {
    yield* loadModel({ request: new Request('https://shell.example.test/en/siampark/work') });
    expect(resolveModuleTargetMock).not.toHaveBeenCalled();
    currentSessionMock.mockReturnValueOnce(Effect.succeed({ state: 'anonymous' }));
    yield* loadModel({ request: request() });
    expect(resolveModuleTargetMock).not.toHaveBeenCalled();
  }),
);
