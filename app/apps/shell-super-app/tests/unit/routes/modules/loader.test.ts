import { beforeEach, expect, rstest, test } from '@rstest/core';
import { Effect } from 'effect';
import * as actualAuthClient from '../../../../src/api/auth-client.ts' with {
  rstest: 'importActual',
};
import {
  loader,
  selectRouteParams,
} from '../../../../src/routes/[lang]/modules/[moduleId]/page.data.ts';
import { loader as contactDetailLoader } from '../../../../src/routes/[lang]/crm/customers/[id]/contacts/[contactId]/page.data.ts';
import { loader as contactEditLoader } from '../../../../src/routes/[lang]/crm/customers/[id]/contacts/[contactId]/edit/page.data.ts';
import { loader as customerDetailLoader } from '../../../../src/routes/[lang]/crm/customers/[id]/page.data.ts';
import { loader as customerCreateLoader } from '../../../../src/routes/[lang]/crm/customers/[id]/new/page.data.ts';
import { loader as customerEditLoader } from '../../../../src/routes/[lang]/crm/customers/[id]/edit/page.data.ts';
import { loader as contactCreateLoader } from '../../../../src/routes/[lang]/crm/customers/[id]/contacts/new/page.data.ts';
import { loader as customersListLoader } from '../../../../src/routes/[lang]/crm/customers/page.data.ts';

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

const request = () =>
  ({
    headers: {
      get: (name: string) => (name.toLowerCase() === 'cookie' ? 'session=test-session' : null),
    },
    url: 'https://shell.example.test/en/crm/customers',
  }) as Request;

beforeEach(() => {
  loadHomePageModelMock.mockResolvedValue(authenticatedShell);
  resolveModuleTargetMock.mockReturnValue(
    Effect.succeed({
      appId: 'crm',
      componentKey: 'crm.core.page-customers',
      entrypointKey: 'crm.core.page.customers',
      moduleId: 'crm.core',
      writable: true,
    }),
  );
});

test('selects only declared safe route parameters and omits overlong values', () => {
  expect(
    selectRouteParams(
      {
        appId: 'attacker-app',
        id: 'customer-1',
        moduleId: 'attacker.module',
        overlong: 'x'.repeat(201),
      },
      ['id', 'overlong'],
    ),
  ).toEqual({ id: 'customer-1' });
});

test('forwards an exact generated page entrypoint through the authenticated client', async () => {
  resolveModuleTargetMock.mockReturnValueOnce(
    Effect.succeed({
      appId: 'crm',
      componentKey: 'crm.core.page-customers-list',
      entrypointKey: 'crm.core.page.customers-list',
      moduleId: 'crm.core',
      writable: true,
    }),
  );
  await expect(customersListLoader({ request: request() })).resolves.toMatchObject({
    state: 'resolved',
    target: { componentKey: 'crm.core.page-customers-list' },
  });
  expect(resolveModuleTargetMock).toHaveBeenCalledWith(
    { entrypointKey: 'crm.core.page.customers-list', moduleId: 'crm.core' },
    {
      baseUrl: new URL('https://shell.example.test/shell-super-app-api'),
      cookie: 'session=test-session',
    },
  );
});

test('forwards only the declared Customer ID after exact Customer-detail resolution', async () => {
  resolveModuleTargetMock.mockReturnValueOnce(
    Effect.succeed({
      appId: 'crm',
      componentKey: 'crm.core.page-customer-detail',
      entrypointKey: 'crm.core.page.customer-detail',
      moduleId: 'crm.core',
      writable: true,
    }),
  );
  await expect(
    customerDetailLoader({
      params: {
        appId: 'attacker-app',
        id: '11111111-1111-4111-8111-111111111111',
        moduleId: 'attacker.module',
      },
      request: request(),
    }),
  ).resolves.toMatchObject({
    routeParams: { id: '11111111-1111-4111-8111-111111111111' },
    state: 'resolved',
    target: {
      componentKey: 'crm.core.page-customer-detail',
      entrypointKey: 'crm.core.page.customer-detail',
    },
  });
  expect(resolveModuleTargetMock).toHaveBeenCalledWith(
    { entrypointKey: 'crm.core.page.customer-detail', moduleId: 'crm.core' },
    expect.any(Object),
  );
});

test('gates Contact detail exactly and forwards only its two bounded hierarchical IDs', async () => {
  resolveModuleTargetMock.mockReturnValueOnce(
    Effect.succeed({
      appId: 'crm',
      componentKey: 'crm.core.page-contact-detail',
      entrypointKey: 'crm.core.page.contact-detail',
      moduleId: 'crm.core',
      writable: true,
    }),
  );
  await expect(
    contactDetailLoader({
      params: {
        appId: 'attacker-app',
        contactId: '33333333-3333-4333-8333-333333333333',
        id: '11111111-1111-4111-8111-111111111111',
        moduleId: 'attacker.module',
        overlong: 'x'.repeat(201),
      },
      request: request(),
    }),
  ).resolves.toMatchObject({
    routeParams: {
      contactId: '33333333-3333-4333-8333-333333333333',
      id: '11111111-1111-4111-8111-111111111111',
    },
    state: 'resolved',
    target: {
      componentKey: 'crm.core.page-contact-detail',
      entrypointKey: 'crm.core.page.contact-detail',
    },
  });
  expect(resolveModuleTargetMock).toHaveBeenCalledWith(
    { entrypointKey: 'crm.core.page.contact-detail', moduleId: 'crm.core' },
    expect.any(Object),
  );
});

test('gates ContactEdit exactly and forwards only its ordered bounded hierarchical IDs', async () => {
  resolveModuleTargetMock.mockReturnValueOnce(
    Effect.succeed({
      appId: 'crm',
      componentKey: 'crm.core.page-contact-edit',
      entrypointKey: 'crm.core.page.contact-edit',
      moduleId: 'crm.core',
      writable: false,
    }),
  );
  await expect(
    contactEditLoader({
      params: {
        appId: 'attacker-app',
        contactId: '33333333-3333-4333-8333-333333333333',
        id: '11111111-1111-4111-8111-111111111111',
        moduleId: 'attacker.module',
        overlong: 'x'.repeat(201),
      },
      request: request(),
    }),
  ).resolves.toMatchObject({
    routeParams: {
      contactId: '33333333-3333-4333-8333-333333333333',
      id: '11111111-1111-4111-8111-111111111111',
    },
    state: 'resolved',
    target: {
      componentKey: 'crm.core.page-contact-edit',
      entrypointKey: 'crm.core.page.contact-edit',
      writable: false,
    },
  });
  expect(resolveModuleTargetMock).toHaveBeenCalledWith(
    { entrypointKey: 'crm.core.page.contact-edit', moduleId: 'crm.core' },
    expect.any(Object),
  );

  rstest.clearAllMocks();
  await expect(
    contactEditLoader({
      params: { contactId: 'x'.repeat(201), id: '11111111-1111-4111-8111-111111111111' },
      request: request(),
    }),
  ).resolves.toMatchObject({
    routeParams: { id: '11111111-1111-4111-8111-111111111111' },
  });
});

test('gates CustomerEdit exactly and carries only its declared bounded Customer ID', async () => {
  resolveModuleTargetMock.mockReturnValueOnce(
    Effect.succeed({
      appId: 'crm',
      componentKey: 'crm.core.page-customer-edit',
      entrypointKey: 'crm.core.page.customer-edit',
      moduleId: 'crm.core',
      writable: false,
    }),
  );
  await expect(
    customerEditLoader({
      params: { appId: 'attacker-app', id: 'customer-1', moduleId: 'attacker.module' },
      request: request(),
    }),
  ).resolves.toMatchObject({
    routeParams: { id: 'customer-1' },
    state: 'resolved',
    target: {
      componentKey: 'crm.core.page-customer-edit',
      entrypointKey: 'crm.core.page.customer-edit',
      writable: false,
    },
  });
  expect(resolveModuleTargetMock).toHaveBeenCalledWith(
    { entrypointKey: 'crm.core.page.customer-edit', moduleId: 'crm.core' },
    expect.any(Object),
  );
});

test('gates CustomerCreate exactly and carries only its declared bounded route ID', async () => {
  resolveModuleTargetMock.mockReturnValueOnce(
    Effect.succeed({
      appId: 'crm',
      componentKey: 'crm.core.page-customer-create',
      entrypointKey: 'crm.core.page.customer-create',
      moduleId: 'crm.core',
      writable: true,
    }),
  );
  await expect(
    customerCreateLoader({
      params: {
        appId: 'attacker-app',
        id: 'untrusted-route-context',
        moduleId: 'attacker.module',
      },
      request: request(),
    }),
  ).resolves.toMatchObject({
    routeParams: { id: 'untrusted-route-context' },
    state: 'resolved',
    target: {
      componentKey: 'crm.core.page-customer-create',
      entrypointKey: 'crm.core.page.customer-create',
      writable: true,
    },
  });
  expect(resolveModuleTargetMock).toHaveBeenCalledWith(
    { entrypointKey: 'crm.core.page.customer-create', moduleId: 'crm.core' },
    expect.any(Object),
  );

  rstest.clearAllMocks();
  await expect(
    customerCreateLoader({
      params: { id: 'x'.repeat(201) },
      request: request(),
    }),
  ).resolves.toMatchObject({ routeParams: {} });
  expect(resolveModuleTargetMock).toHaveBeenCalledWith(
    { entrypointKey: 'crm.core.page.customer-create', moduleId: 'crm.core' },
    expect.any(Object),
  );
});

test('gates ContactCreate exactly and carries only its declared bounded Customer ID', async () => {
  resolveModuleTargetMock.mockReturnValueOnce(
    Effect.succeed({
      appId: 'crm',
      componentKey: 'crm.core.page-contact-create',
      entrypointKey: 'crm.core.page.contact-create',
      moduleId: 'crm.core',
      writable: false,
    }),
  );
  await expect(
    contactCreateLoader({
      params: {
        appId: 'attacker-app',
        id: '11111111-1111-4111-8111-111111111111',
        moduleId: 'attacker.module',
      },
      request: request(),
    }),
  ).resolves.toMatchObject({
    routeParams: { id: '11111111-1111-4111-8111-111111111111' },
    state: 'resolved',
    target: {
      componentKey: 'crm.core.page-contact-create',
      entrypointKey: 'crm.core.page.contact-create',
      writable: false,
    },
  });
  expect(resolveModuleTargetMock).toHaveBeenCalledWith(
    { entrypointKey: 'crm.core.page.contact-create', moduleId: 'crm.core' },
    expect.any(Object),
  );
});

test('retains only declared bounded route parameters outside the resolved target identity', async () => {
  await expect(
    loader({
      params: { entrypointKey: 'crm.core.page.customers', moduleId: 'crm.core' },
      request: request(),
      routeParams: { id: 'customer-1' },
    }),
  ).resolves.toMatchObject({
    routeParams: { id: 'customer-1' },
    state: 'resolved',
    target: {
      appId: 'crm',
      componentKey: 'crm.core.page-customers',
      entrypointKey: 'crm.core.page.customers',
      moduleId: 'crm.core',
    },
  });
  expect(resolveModuleTargetMock).toHaveBeenCalledWith(
    { entrypointKey: 'crm.core.page.customers', moduleId: 'crm.core' },
    expect.any(Object),
  );
});

test('retains module landing behavior when no exact page entrypoint is supplied', async () => {
  await expect(
    loader({ params: { moduleId: 'crm.core' }, request: request() }),
  ).resolves.toMatchObject({ routeParams: {} });
  expect(resolveModuleTargetMock).toHaveBeenCalledWith(
    { moduleId: 'crm.core' },
    expect.any(Object),
  );
});

test('does not request or load a private target before authentication', async () => {
  loadHomePageModelMock.mockResolvedValueOnce({ state: 'anonymous' });
  await expect(
    loader({
      params: { entrypointKey: 'crm.core.page.customers', moduleId: 'crm.core' },
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
      params: { entrypointKey: 'crm.core.page.customers', moduleId: 'crm.core' },
      request: request(),
    }),
  ).resolves.toMatchObject({ state });
});
