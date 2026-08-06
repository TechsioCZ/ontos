import { beforeEach, expect, rstest, test } from '@rstest/core';
import { Effect } from 'effect';
import * as actualAuthClient from '../../../../src/api/auth-client.ts' with {
  rstest: 'importActual',
};
import { loader } from '../../../../src/routes/[lang]/page.data.ts';

const { activeModulesMock, availableTenantsMock, currentSessionMock } = rstest.hoisted(() => ({
  activeModulesMock: rstest.fn(),
  availableTenantsMock: rstest.fn(),
  currentSessionMock: rstest.fn(),
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  ...actualAuthClient,
  activeModules: activeModulesMock,
  availableTenants: availableTenantsMock,
  currentSession: currentSessionMock,
  runEffectRequest: Effect.runPromise,
}));

const identity = {
  displayName: 'Ada Lovelace',
  email: 'ada@example.test',
  principalId: 'principal-1',
  tenantId: 'tenant-1',
};

const request = () =>
  ({
    headers: {
      get: (name: string) => (name.toLowerCase() === 'cookie' ? 'session=test-session' : null),
    },
    url: 'https://shell.example.test/en',
  }) as Request;

beforeEach(() => {
  currentSessionMock.mockReturnValue(Effect.succeed({ identity, state: 'authenticated' as const }));
  activeModulesMock.mockReturnValue(
    Effect.succeed([
      { moduleKey: 'future-generated', state: 'active' as const },
      { moduleKey: 'testing1', state: 'active' as const },
    ]),
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

test('resolves the session first and returns a serializable authenticated page model', async () => {
  const model = await loader({ request: request() });

  expect(model).toEqual({
    activeModules: {
      items: [
        { moduleKey: 'future-generated', state: 'active' },
        { moduleKey: 'testing1', state: 'active' },
      ],
      state: 'available',
    },
    identity,
    state: 'authenticated',
    tenants: {
      items: [
        { name: 'Alpha tenant', tenantId: 'tenant-1' },
        { name: 'Zeta tenant', tenantId: 'tenant-2' },
      ],
      state: 'available',
    },
  });
  expect(currentSessionMock).toHaveBeenCalledWith({
    baseUrl: new URL('https://shell.example.test/shell-super-app-api'),
    cookie: 'session=test-session',
  });
  expect(activeModulesMock).toHaveBeenCalledWith({
    baseUrl: new URL('https://shell.example.test/shell-super-app-api'),
    cookie: 'session=test-session',
  });
  expect(availableTenantsMock).toHaveBeenCalledWith({
    baseUrl: new URL('https://shell.example.test/shell-super-app-api'),
    cookie: 'session=test-session',
  });
  expect(currentSessionMock.mock.invocationCallOrder[0]).toBeLessThan(
    activeModulesMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
  );
});

test('does not request modules for an anonymous session', async () => {
  currentSessionMock.mockReturnValueOnce(Effect.succeed({ state: 'anonymous' as const }));

  expect(await loader({ request: request() })).toEqual({ state: 'anonymous' });
  expect(activeModulesMock).not.toHaveBeenCalled();
  expect(availableTenantsMock).not.toHaveBeenCalled();
});

test('maps a typed module-client failure to unavailable without discarding identity', async () => {
  activeModulesMock.mockReturnValueOnce(
    Effect.fail({
      _tag: 'ActiveModulesUnavailableProblem' as const,
      detail: 'safe',
      retryable: true as const,
      status: 503,
      title: 'safe',
      type: 'safe',
    }),
  );

  expect(await loader({ request: request() })).toEqual({
    activeModules: { items: [], state: 'unavailable' },
    identity,
    state: 'authenticated',
    tenants: {
      items: [
        { name: 'Alpha tenant', tenantId: 'tenant-1' },
        { name: 'Zeta tenant', tenantId: 'tenant-2' },
      ],
      state: 'available',
    },
  });
});

test('maps a tenant failure to a current-tenant fallback without discarding modules', async () => {
  availableTenantsMock.mockReturnValueOnce(
    Effect.fail({
      _tag: 'TenantCapabilityUnavailableProblem' as const,
      detail: 'safe',
      retryable: true as const,
      status: 503,
      title: 'safe',
      type: 'safe',
    }),
  );

  expect(await loader({ request: request() })).toEqual({
    activeModules: {
      items: [
        { moduleKey: 'future-generated', state: 'active' },
        { moduleKey: 'testing1', state: 'active' },
      ],
      state: 'available',
    },
    identity,
    state: 'authenticated',
    tenants: {
      items: [{ name: 'tenant-1', tenantId: 'tenant-1' }],
      state: 'unavailable',
    },
  });
});

test('tears down stale authenticated data when the tenant read requires authentication', async () => {
  availableTenantsMock.mockReturnValueOnce(
    Effect.fail({
      _tag: 'TenantAuthenticationRequiredProblem' as const,
      detail: 'safe',
      status: 401,
      title: 'safe',
      type: 'safe',
    }),
  );

  expect(await loader({ request: request() })).toEqual({ state: 'anonymous' });
});

test('keeps the previous anonymous fallback for a session-client failure', async () => {
  currentSessionMock.mockReturnValueOnce(
    Effect.fail({
      _tag: 'AuthenticationUnavailableProblem' as const,
      detail: 'safe',
      status: 503,
      title: 'safe',
      type: 'safe',
    }),
  );

  expect(await loader({ request: request() })).toEqual({ state: 'anonymous' });
  expect(activeModulesMock).not.toHaveBeenCalled();
  expect(availableTenantsMock).not.toHaveBeenCalled();
});
