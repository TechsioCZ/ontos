import { beforeEach, expect, rstest, test } from '@rstest/core';
import { Effect } from 'effect';
import * as actualAuthClient from '../../../../src/api/auth-client.ts' with {
  rstest: 'importActual',
};
import { loader } from '../../../../src/routes/[lang]/page.data.ts';

const {
  availableLegalEntitiesMock,
  availableTenantsMock,
  currentSessionMock,
  shellCompositionMock,
} = rstest.hoisted(() => ({
  availableLegalEntitiesMock: rstest.fn(),
  availableTenantsMock: rstest.fn(),
  currentSessionMock: rstest.fn(),
  shellCompositionMock: rstest.fn(),
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  ...actualAuthClient,
  availableLegalEntities: availableLegalEntitiesMock,
  availableTenants: availableTenantsMock,
  currentSession: currentSessionMock,
  runEffectRequest: Effect.runPromise,
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
  ({
    headers: {
      get: (name: string) => (name.toLowerCase() === 'cookie' ? 'session=test-session' : null),
    },
    url: 'https://shell.example.test/en',
  }) as Request;

beforeEach(() => {
  currentSessionMock.mockReturnValue(Effect.succeed({ identity, state: 'authenticated' as const }));
  availableLegalEntitiesMock.mockReturnValue(
    Effect.succeed({
      legalEntities: [{ legalEntityId: 'legal-1', legalName: 'Alpha company' }],
      selectedLegalEntityId: 'legal-1',
      state: 'authenticated',
    }),
  );
  shellCompositionMock.mockReturnValue(Effect.succeed({ navigation, state: 'available' as const }));
  availableTenantsMock.mockReturnValue(
    Effect.succeed({
      tenants: [
        { name: 'Alpha tenant', tenantId: 'tenant-1' },
        { name: 'Zeta tenant', tenantId: 'tenant-2' },
      ],
    }),
  );
});

test('resolves trusted context before returning one serializable composition', async () => {
  expect(await loader({ request: request() })).toEqual({
    contextState: 'authenticated',
    identity,
    legalEntities: {
      items: [{ legalEntityId: 'legal-1', legalName: 'Alpha company' }],
      state: 'available',
    },
    navigation: { items: navigation, state: 'available' },
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
});

test('does not request composition for an anonymous session', async () => {
  currentSessionMock.mockReturnValueOnce(Effect.succeed({ state: 'anonymous' as const }));
  expect(await loader({ request: request() })).toEqual({ state: 'anonymous' });
  expect(shellCompositionMock).not.toHaveBeenCalled();
  expect(availableTenantsMock).not.toHaveBeenCalled();
});

test('maps composition failure to unavailable without discarding verified context', async () => {
  shellCompositionMock.mockReturnValueOnce(
    Effect.fail({ _tag: 'ShellCapabilityUnavailableProblem' }),
  );
  expect(await loader({ request: request() })).toMatchObject({
    contextState: 'authenticated',
    identity,
    navigation: { items: [], state: 'unavailable' },
    state: 'authenticated',
  });
});

test('maps tenant failure to the current-tenant fallback without discarding composition', async () => {
  availableTenantsMock.mockReturnValueOnce(
    Effect.fail({ _tag: 'TenantCapabilityUnavailableProblem' }),
  );
  expect(await loader({ request: request() })).toMatchObject({
    navigation: { items: navigation, state: 'available' },
    tenants: { items: [{ name: 'tenant-1', tenantId: 'tenant-1' }], state: 'unavailable' },
  });
});

test('keeps legal-entity acquisition failure explicit without claiming choices are available', async () => {
  availableLegalEntitiesMock.mockReturnValueOnce(
    Effect.fail({ _tag: 'TenantCapabilityUnavailableProblem' }),
  );
  expect(await loader({ request: request() })).toMatchObject({
    legalEntities: { items: [], state: 'unavailable' },
    state: 'authenticated',
  });
});

test('does not collapse an authentication infrastructure failure into an anonymous session', async () => {
  currentSessionMock.mockReturnValueOnce(Effect.fail({ _tag: 'AuthenticationUnavailableProblem' }));
  expect(await loader({ request: request() })).toEqual({ state: 'unavailable' });
});

test('tears down stale authenticated data when tenant context requires authentication', async () => {
  availableTenantsMock.mockReturnValueOnce(
    Effect.fail({ _tag: 'TenantAuthenticationRequiredProblem' }),
  );
  expect(await loader({ request: request() })).toEqual({ state: 'anonymous' });
});
