import { afterEach, beforeEach, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect } from 'effect';
import type { ReactNode } from 'react';
import { HomeView } from '../../../../src/routes/[lang]/page.tsx';
import type { HomePageModel } from '../../../../src/routes/[lang]/page.data.ts';

const { navigateMock, runEffectRequestMock, signOutMock, switchLegalEntityMock, switchTenantMock } =
  rstest.hoisted(() => ({
    navigateMock: rstest.fn(),
    runEffectRequestMock: rstest.fn(),
    signOutMock: rstest.fn(),
    switchLegalEntityMock: rstest.fn(),
    switchTenantMock: rstest.fn(),
  }));

const translations = new Map(
  Object.entries({
    'shell.auth.identity.displayName': 'Name',
    'shell.auth.identity.email': 'Email',
    'shell.auth.identity.legalEntity': 'Legal entity',
    'shell.auth.identity.principal': 'Principal',
    'shell.auth.identity.tenant': 'Tenant',
    'shell.auth.identity.title': 'Authenticated identity',
    'shell.auth.loginLink': 'Login',
    'shell.auth.logout.action': 'Logout',
    'shell.auth.logout.failed': 'Logout failed',
    'shell.dashboard.account.label': 'Account menu',
    'shell.dashboard.brand': 'OntOS',
    'shell.dashboard.header.label': 'Dashboard header',
    'shell.dashboard.home.title': 'Home',
    'shell.dashboard.legalEntity.accessibleLabel': 'Current legal entity',
    'shell.dashboard.legalEntity.failed': 'Legal entity switching failed',
    'shell.dashboard.legalEntity.pending': 'Switching legal entity',
    'shell.dashboard.legalEntity.unavailable': 'Legal entities unavailable',
    'shell.dashboard.navigation.home': 'Home',
    'shell.dashboard.navigation.label': 'Dashboard navigation',
    'shell.dashboard.sidebar.label': 'Dashboard sidebar',
    'shell.dashboard.tenant.accessibleLabel': 'Current tenant',
    'shell.dashboard.tenant.failed': 'Tenant switching failed',
    'shell.dashboard.tenant.pending': 'Switching tenant',
    'shell.dashboard.tenant.unavailable': 'Tenants unavailable',
    'shell.modules.state.active': 'Active',
    'shell.modules.state.readOnly': 'Read only',
    'shell.modules.unavailable': 'Module access unavailable',
    'shell.search.label': 'Search this legal entity',
    'shell.search.submit': 'Search',
  }),
);

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={`/en${to === '/' ? '/' : to}`} {...props}>
      {children}
    </a>
  ),
  useLocalizedLocation: () => ({ alternates: { cs: '/cs/', en: '/en/' }, canonical: '/en/' }),
  useModernI18n: () => ({
    language: 'en',
    t: (key: string) => translations.get(key) ?? key,
  }),
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useLoaderData: rstest.fn(),
  useNavigate: () => navigateMock,
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  runEffectRequest: runEffectRequestMock,
  signOut: signOutMock,
  switchLegalEntity: switchLegalEntityMock,
  switchTenant: switchTenantMock,
}));

const authenticatedModel = (): HomePageModel => ({
  contextState: 'authenticated',
  identity: {
    displayName: 'Ada Lovelace',
    email: 'ada@example.test',
    legalEntityId: 'legal-1',
    legalName: 'Alpha company',
    principalId: 'principal-1',
    tenantId: 'tenant-1',
  },
  legalEntities: {
    items: [
      { legalEntityId: 'legal-1', legalName: 'Alpha company' },
      { legalEntityId: 'legal-2', legalName: 'Beta company' },
    ],
    state: 'available',
  },
  navigation: {
    items: [
      {
        appId: 'inventory-app',
        enabled: true,
        groupKey: 'shell.navigation.modules',
        href: '/modules/inventory.stock',
        label: 'Inventory',
        moduleId: 'inventory.stock',
        order: 10,
        state: 'read_only',
        unavailable: false,
        writable: false,
      },
    ],
    state: 'available',
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

beforeEach(() => {
  navigateMock.mockResolvedValue();
  runEffectRequestMock.mockImplementation((effect: Effect.Effect<unknown, unknown>) =>
    Effect.runPromise(effect),
  );
  signOutMock.mockReturnValue(Effect.succeed({ signedOut: true }));
  switchTenantMock.mockReturnValue(Effect.succeed({ selectedTenantId: 'tenant-2' }));
  switchLegalEntityMock.mockReturnValue(Effect.succeed({ selectedLegalEntityId: 'legal-2' }));
});

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

test('anonymous home exposes only the localized login action', () => {
  render(<HomeView initialModel={{ state: 'anonymous' }} />);
  expect(screen.getByRole('link', { name: 'Login' }).getAttribute('href')).toBe('/en/login');
  expect(screen.queryByRole('banner')).toBeNull();
});

test('authenticated home renders server-composed navigation and selected legal context', () => {
  render(<HomeView initialModel={authenticatedModel()} />);
  expect(screen.getByRole('link', { name: 'Inventory' }).getAttribute('href')).toBe(
    '/en/modules/inventory.stock',
  );
  expect(screen.getByText('Read only')).toBeTruthy();
  expect(screen.getByText('legal-1')).toBeTruthy();
  expect(screen.queryByText('inventory.stock')).toBeNull();
});

test('successful tenant switch performs a full document reload', async () => {
  const user = userEvent.setup();
  render(<HomeView initialModel={authenticatedModel()} />);
  await user.click(screen.getByRole('combobox', { name: 'Current tenant' }));
  await user.click(await screen.findByRole('option', { name: 'Zeta tenant' }));
  await waitFor(() =>
    expect(switchTenantMock).toHaveBeenCalledWith({ tenantId: 'tenant-2' }, { locale: 'en' }),
  );
  await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ reloadDocument: true, to: '.' }));
});

test('successful legal-entity switch performs a full document reload', async () => {
  const user = userEvent.setup();
  render(<HomeView initialModel={authenticatedModel()} />);
  await user.click(screen.getByRole('combobox', { name: 'Current legal entity' }));
  await user.click(await screen.findByRole('option', { name: 'Beta company' }));
  await waitFor(() =>
    expect(switchLegalEntityMock).toHaveBeenCalledWith(
      { legalEntityId: 'legal-2' },
      { locale: 'en' },
    ),
  );
  await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ reloadDocument: true, to: '.' }));
});

test('search submission navigates to the localized Shell search route', async () => {
  const user = userEvent.setup();
  render(<HomeView initialModel={authenticatedModel()} />);
  await user.type(screen.getByLabelText('Search this legal entity'), 'Unit 1');
  await user.click(screen.getByRole('button', { name: 'Search' }));
  expect(navigateMock).toHaveBeenCalledWith({ to: '/en/search?q=Unit%201' });
});

test('logout clears the authenticated composition together', async () => {
  const user = userEvent.setup();
  render(<HomeView initialModel={authenticatedModel()} />);
  await user.click(screen.getByRole('button', { name: 'Ada Lovelace' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Logout' }));
  await waitFor(() =>
    expect(navigateMock).toHaveBeenCalledWith({ reloadDocument: true, to: '/en/login' }),
  );
});
