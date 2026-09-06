import { beforeEach, expect, rstest, test } from '@rstest/core';
import { Effect } from 'effect';
import * as actualAuthClient from '../../../../src/api/auth-client.ts' with {
  rstest: 'importActual',
};
import {
  loader,
  selectRouteParams,
} from '../../../../src/routes/[lang]/modules/[moduleId]/page.data.ts';

const { loadHomePageModelMock, resolveModuleTargetMock } = rstest.hoisted(() => ({
  loadHomePageModelMock: rstest.fn(),
  resolveModuleTargetMock: rstest.fn(),
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  ...actualAuthClient,
  resolveModuleTarget: resolveModuleTargetMock,
  runEffectRequest: Effect.runPromise,
}));

rstest.mock('../../../../src/routes/[lang]/page.data.ts', () => ({
  loadHomePageModel: loadHomePageModelMock,
}));

const authenticatedShell = {
  contextState: 'authenticated' as const,
  identity: {
    displayName: 'Ada Lovelace',
    email: 'ada@example.test',
    legalEntityId: 'legal-1',
    legalName: 'Alpha company',
    principalId: 'principal-1',
    tenantId: 'tenant-1',
  },
  legalEntities: { items: [], state: 'available' as const },
  navigation: { items: [], state: 'available' as const },
  selectedLegalEntityId: 'legal-1',
  state: 'authenticated' as const,
  tenants: { items: [], state: 'available' as const },
};

const request = () => {
  const value = new Request('https://shell.example.test/en/contacts');
  Object.defineProperty(value, 'headers', {
    value: new Headers({ cookie: 'session=test-session' }),
  });
  return value;
};

beforeEach(() => {
  loadHomePageModelMock.mockResolvedValue(authenticatedShell);
  resolveModuleTargetMock.mockReturnValue(
    Effect.succeed({
      appId: 'party-registry',
      componentKey: 'party.registry.page-contacts',
      entrypointKey: 'party.registry.page.contacts',
      moduleId: 'party.registry',
      writable: false,
    }),
  );
});

test('selects only declared safe route parameters and omits overlong values', () => {
  expect(
    selectRouteParams(
      {
        appId: 'attacker-app',
        id: 'party-1',
        moduleId: 'attacker.module',
        overlong: 'x'.repeat(201),
      },
      ['id', 'overlong'],
    ),
  ).toEqual({ id: 'party-1' });
});

test('retains only declared bounded route parameters outside the resolved target identity', async () => {
  await expect(
    loader({
      params: {
        entrypointKey: 'party.registry.page.contacts',
        moduleId: 'party.registry',
      },
      request: request(),
      routeParams: { id: 'party-1' },
    }),
  ).resolves.toMatchObject({
    routeParams: { id: 'party-1' },
    state: 'resolved',
    target: {
      appId: 'party-registry',
      componentKey: 'party.registry.page-contacts',
      entrypointKey: 'party.registry.page.contacts',
      moduleId: 'party.registry',
    },
  });
  expect(resolveModuleTargetMock).toHaveBeenCalledWith(
    { entrypointKey: 'party.registry.page.contacts', moduleId: 'party.registry' },
    expect.any(Object),
  );
});

test('retains module landing behavior when no exact page entrypoint is supplied', async () => {
  await expect(
    loader({ params: { moduleId: 'party.registry' }, request: request() }),
  ).resolves.toMatchObject({ routeParams: {} });
  expect(resolveModuleTargetMock).toHaveBeenCalledWith(
    { moduleId: 'party.registry' },
    expect.any(Object),
  );
});

test('does not request or load a private target before authentication', async () => {
  loadHomePageModelMock.mockResolvedValueOnce({ state: 'anonymous' });
  await expect(
    loader({
      params: {
        entrypointKey: 'party.registry.page.contacts',
        moduleId: 'party.registry',
      },
      request: request(),
    }),
  ).resolves.toMatchObject({ state: 'selection_required' });
  expect(resolveModuleTargetMock).not.toHaveBeenCalled();
});

test.each([
  ['ShellSelectionRequiredProblem', 'selection_required'],
  ['ShellTargetForbiddenProblem', 'forbidden'],
  ['ShellTargetNotFoundProblem', 'not_found'],
  ['ShellCapabilityUnavailableProblem', 'unavailable'],
] as const)('maps %s without returning a resolved private target', async (_tag, state) => {
  resolveModuleTargetMock.mockReturnValueOnce(Effect.fail({ _tag }));
  await expect(
    loader({
      params: {
        entrypointKey: 'party.registry.page.contacts',
        moduleId: 'party.registry',
      },
      request: request(),
    }),
  ).resolves.toMatchObject({ state });
});
