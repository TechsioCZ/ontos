import { afterEach, beforeEach, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Effect } from 'effect';
import type { ReactNode } from 'react';
import ModuleTargetPage from '../../../../src/routes/[lang]/modules/[moduleId]/page.tsx';
import type { ModuleTargetPageModel } from '../../../../src/routes/[lang]/modules/[moduleId]/page.data.ts';

const { findApprovedVerticalPageClientMock, loadRemotePageMock, useLoaderDataMock } =
  rstest.hoisted(() => ({
    findApprovedVerticalPageClientMock: rstest.fn(),
    loadRemotePageMock: rstest.fn(),
    useLoaderDataMock: rstest.fn(),
  }));

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ t: (key: string) => key }),
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useLoaderData: useLoaderDataMock,
}));

rstest.mock('@techsio/ui-kit/atoms/status-text', () => ({
  StatusText: ({ children }: { readonly children: ReactNode }) => <span>{children}</span>,
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  runEffectRequest: Effect.runPromise,
}));

rstest.mock('../../../../src/api/vertical-clients.ts', () => ({
  findApprovedVerticalPageClient: findApprovedVerticalPageClientMock,
}));

rstest.mock('../../../../src/routes/shell-frame.tsx', () => ({
  AuthenticatedDashboardLayout: ({ children }: { readonly children: ReactNode }) => (
    <main>{children}</main>
  ),
}));

rstest.mock('../../../../src/routes/use-shell-controls.ts', () => ({
  useShellControls: () => ({
    handleLegalEntityChange: rstest.fn(),
    handleLogout: rstest.fn(),
    handleSearch: rstest.fn(),
    handleTenantChange: rstest.fn(),
    legalEntitySwitchFailed: false,
    legalEntitySwitchPending: false,
    logoutFailed: false,
    logoutPending: false,
    tenantSwitchFailed: false,
    tenantSwitchPending: false,
  }),
}));

const shell = {
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

const resolvedModel: ModuleTargetPageModel = {
  routeParams: { id: 'customer-1' },
  shell,
  state: 'resolved',
  target: {
    appId: 'crm',
    componentKey: 'crm.core.page-customers',
    entrypointKey: 'crm.core.page.customers',
    moduleId: 'crm.core',
    writable: true,
  },
};

beforeEach(() => {
  loadRemotePageMock.mockResolvedValue({
    default: ({
      routeParams,
      target,
    }: {
      readonly routeParams: Readonly<Record<string, string>>;
      readonly target: { readonly componentKey: string };
    }) => <div>{`${target.componentKey}:${routeParams['id'] ?? 'static'}`}</div>,
  });
  findApprovedVerticalPageClientMock.mockReturnValue({ load: loadRemotePageMock });
});

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

test.each(['selection_required', 'forbidden', 'not_found', 'unavailable'] as const)(
  'does not consult or invoke the private registry for a %s exact-page response',
  (state) => {
    useLoaderDataMock.mockReturnValue({ shell, state } satisfies ModuleTargetPageModel);
    render(<ModuleTargetPage />);
    expect(findApprovedVerticalPageClientMock).not.toHaveBeenCalled();
    expect(loadRemotePageMock).not.toHaveBeenCalled();
  },
);

test('invokes the exact private page loader only after a resolved authenticated response', async () => {
  useLoaderDataMock.mockReturnValue(resolvedModel);
  render(<ModuleTargetPage />);
  expect(findApprovedVerticalPageClientMock).toHaveBeenCalledWith(resolvedModel.target);
  await waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('crm.core.page-customers:customer-1')).toBeTruthy();
});

test('passes an empty route-parameter record to a resolved static page', async () => {
  useLoaderDataMock.mockReturnValue({ ...resolvedModel, routeParams: {} });
  render(<ModuleTargetPage />);
  await waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('crm.core.page-customers:static')).toBeTruthy();
});

test('loads the generated Customers list page as a static exact target', async () => {
  const customersListModel: ModuleTargetPageModel = {
    ...resolvedModel,
    routeParams: {},
    target: {
      ...resolvedModel.target,
      componentKey: 'crm.core.page-customers-list',
      entrypointKey: 'crm.core.page.customers-list',
    },
  };
  useLoaderDataMock.mockReturnValue(customersListModel);
  render(<ModuleTargetPage />);
  expect(findApprovedVerticalPageClientMock).toHaveBeenCalledWith(customersListModel.target);
  await waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('crm.core.page-customers-list:static')).toBeTruthy();
});

test('loads the approved Customer-detail remote once with the exact declared Customer ID', async () => {
  const customerDetailModel: ModuleTargetPageModel = {
    ...resolvedModel,
    routeParams: { id: '11111111-1111-4111-8111-111111111111' },
    target: {
      ...resolvedModel.target,
      componentKey: 'crm.core.page-customer-detail',
      entrypointKey: 'crm.core.page.customer-detail',
    },
  };
  useLoaderDataMock.mockReturnValue(customerDetailModel);
  render(<ModuleTargetPage />);
  expect(findApprovedVerticalPageClientMock).toHaveBeenCalledWith(customerDetailModel.target);
  await waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1));
  expect(
    await screen.findByText('crm.core.page-customer-detail:11111111-1111-4111-8111-111111111111'),
  ).toBeTruthy();
});
