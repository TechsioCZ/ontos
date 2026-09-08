import { beforeEach, expect, rstest, it } from 'effect-rstest';
import { ConfigProvider, Effect } from 'effect';
import * as actualAuthClient from '../../../../src/api/auth-client.ts' with {
  rstest: 'importActual',
};
import { loadHomePageModel } from '../../../../src/routes/[lang]/page.data.ts';

const {
  availableLegalEntitiesMock,
  availableTenantsMock,
  browserConfigValuesMock,
  currentSessionMock,
  shellCompositionMock,
} = rstest.hoisted(() => ({
  availableLegalEntitiesMock: rstest.fn(),
  availableTenantsMock: rstest.fn(),
  browserConfigValuesMock: rstest.fn<() => { readonly BETTER_AUTH_URL?: string }>(),
  currentSessionMock: rstest.fn(),
  shellCompositionMock: rstest.fn(),
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  ...actualAuthClient,
  availableLegalEntities: availableLegalEntitiesMock,
  availableTenants: availableTenantsMock,
  currentSession: currentSessionMock,
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

const loadModel = ({ request: input }: { readonly request: Request }) =>
  Effect.suspend(() =>
    loadHomePageModel(input).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(browserConfigValuesMock()),
      ),
    ),
  );
const withBetterAuthUrl = <Value, Failure>(
  baseUrl: string,
  operation: () => Effect.Effect<Value, Failure>,
) =>
  Effect.suspend(() => {
    browserConfigValuesMock.mockReturnValueOnce({ BETTER_AUTH_URL: baseUrl });
    return operation();
  });

beforeEach(() => {
  browserConfigValuesMock.mockReturnValue({});
  currentSessionMock.mockReturnValue(Effect.succeed({ identity, state: 'authenticated' as const }));
  availableLegalEntitiesMock.mockReturnValue(
    Effect.succeed({
      legalEntities: [{ legalEntityId: 'legal-1', legalName: 'Alpha company' }],
      selectedLegalEntityId: 'legal-1',
      state: 'authenticated',
    }),
  );
  shellCompositionMock.mockReturnValue(
    Effect.succeed({ navigation, state: 'available' as const, unavailableDeployments: [] }),
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
      contextState: 'authenticated',
      identity,
      legalEntities: {
        items: [{ legalEntityId: 'legal-1', legalName: 'Alpha company' }],
        state: 'available',
      },
      navigation: { items: navigation, state: 'available', unavailableDeployments: [] },
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
  }),
);

it.effect('does not request composition for an anonymous session', () =>
  Effect.gen(function* verifyCase2() {
    currentSessionMock.mockReturnValueOnce(Effect.succeed({ state: 'anonymous' as const }));
    expect(yield* loadModel({ request: request() })).toEqual({ state: 'anonymous' });
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
        return yield* loadModel({ request: new Request('http://shell.stage.example.test/en') });
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
        return yield* loadModel({ request: new Request('http://localhost:3020/en') });
      }),
    );

    expect(currentSessionMock.mock.calls.at(-1)?.[0]?.baseUrl.toString()).toBe(
      'http://localhost:3020/shell-super-app-api',
    );
  }),
);

it.effect('maps composition failure to unavailable without discarding verified context', () =>
  Effect.gen(function* verifyCase8() {
    shellCompositionMock.mockReturnValueOnce(
      Effect.fail({ _tag: 'ShellCapabilityUnavailableProblem' }),
    );
    expect(yield* loadModel({ request: request() })).toMatchObject({
      contextState: 'authenticated',
      identity,
      navigation: { items: [], state: 'unavailable' },
      state: 'authenticated',
    });
  }),
);

it.effect('maps tenant failure to the current-tenant fallback without discarding composition', () =>
  Effect.gen(function* verifyCase9() {
    availableTenantsMock.mockReturnValueOnce(
      Effect.fail({ _tag: 'TenantCapabilityUnavailableProblem' }),
    );
    expect(yield* loadModel({ request: request() })).toMatchObject({
      navigation: { items: navigation, state: 'available' },
      tenants: { items: [{ name: 'tenant-1', tenantId: 'tenant-1' }], state: 'unavailable' },
    });
  }),
);

it.effect(
  'keeps legal-entity acquisition failure explicit without claiming choices are available',
  () =>
    Effect.gen(function* verifyCase10() {
      availableLegalEntitiesMock.mockReturnValueOnce(
        Effect.fail({ _tag: 'TenantCapabilityUnavailableProblem' }),
      );
      expect(yield* loadModel({ request: request() })).toMatchObject({
        legalEntities: { items: [], state: 'unavailable' },
        state: 'authenticated',
      });
    }),
);

it.effect(
  'does not collapse an authentication infrastructure failure into an anonymous session',
  () =>
    Effect.gen(function* verifyCase11() {
      currentSessionMock.mockReturnValueOnce(
        Effect.fail({ _tag: 'AuthenticationUnavailableProblem' }),
      );
      expect(yield* loadModel({ request: request() })).toEqual({ state: 'unavailable' });
    }),
);

it.effect('tears down stale authenticated data when tenant context requires authentication', () =>
  Effect.gen(function* verifyCase12() {
    availableTenantsMock.mockReturnValueOnce(
      Effect.fail({ _tag: 'TenantAuthenticationRequiredProblem' }),
    );
    expect(yield* loadModel({ request: request() })).toEqual({ state: 'anonymous' });
  }),
);
