import { afterEach, beforeEach, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect } from 'effect';
import type { ReactNode } from 'react';
import { HomeView } from '../../../../src/routes/[lang]/page.tsx';
import type { HomePageModel } from '../../../../src/routes/[lang]/page.data.ts';
import type { SwitchTenantClientError } from '../../../../src/api/auth-client.ts';

const { navigateMock, runEffectRequestMock, signOutMock, switchTenantMock } = rstest.hoisted(
  () => ({
    navigateMock: rstest.fn(),
    runEffectRequestMock: rstest.fn(),
    signOutMock: rstest.fn(),
    switchTenantMock: rstest.fn(),
  }),
);

const translations: Record<string, string> = {
  'shell.auth.identity.displayName': 'Name',
  'shell.auth.identity.email': 'Email',
  'shell.auth.identity.principal': 'Principal',
  'shell.auth.identity.tenant': 'Tenant',
  'shell.auth.identity.title': 'Authenticated identity',
  'shell.auth.loginLink': 'Login',
  'shell.auth.logout.action': 'Logout',
  'shell.auth.logout.failed': 'Logout failed. Try again.',
  'shell.auth.logout.pending': 'Logging out…',
  'shell.dashboard.account.label': 'Account menu',
  'shell.dashboard.brand': 'OntOS',
  'shell.dashboard.header.label': 'Dashboard header',
  'shell.dashboard.home.title': 'Home',
  'shell.dashboard.navigation.home': 'Home',
  'shell.dashboard.navigation.label': 'Dashboard navigation',
  'shell.dashboard.sidebar.label': 'Dashboard sidebar',
  'shell.dashboard.tenant.accessibleLabel': 'Current tenant',
  'shell.dashboard.tenant.failed': 'Tenant switching failed. Try again.',
  'shell.dashboard.tenant.pending': 'Switching tenant…',
  'shell.dashboard.tenant.unavailable': 'Tenant choices are temporarily unavailable.',
  'shell.modules.active.item': '{{moduleKey}}: {{state}}',
  'shell.modules.active.label': 'Active MicroVerticals',
  'shell.modules.active.unavailable': 'Active MicroVerticals are temporarily unavailable.',
  'shell.modules.state.active': 'Active',
};

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  Link: ({
    children,
    to,
    ...props
  }: {
    children: ReactNode;
    to: string;
    [key: string]: unknown;
  }) => (
    <a href={`/en${to === '/' ? '/' : to}`} {...props}>
      {children}
    </a>
  ),
  useLocalizedLocation: () => ({
    alternates: {
      cs: '/cs/',
      en: '/en/',
    },
    canonical: '/en/',
  }),
  useModernI18n: () => ({
    language: 'en',
    t: (key: string, values?: Readonly<Record<string, string>>) => {
      let result = translations[key] ?? key;
      for (const [name, value] of Object.entries(values ?? {})) {
        result = result.replaceAll(`{{${name}}}`, value);
      }
      return result;
    },
  }),
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useLoaderData: rstest.fn(),
  useNavigate: () => navigateMock,
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  runEffectRequest: runEffectRequestMock,
  signOut: signOutMock,
  switchTenant: switchTenantMock,
}));

const defaultActiveModules: Extract<HomePageModel, { state: 'authenticated' }>['activeModules'] = {
  items: [
    { moduleKey: 'future-generated', state: 'active' },
    { moduleKey: 'testing1', state: 'active' },
  ],
  state: 'available',
};

const authenticatedModel = (
  activeModules: Extract<
    HomePageModel,
    { state: 'authenticated' }
  >['activeModules'] = defaultActiveModules,
): HomePageModel => ({
  activeModules,
  identity: {
    displayName: 'Ada Lovelace',
    email: 'ada@example.test',
    principalId: 'principal-1',
    tenantId: 'tenant-1',
  },
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
  runEffectRequestMock.mockImplementation((request: Effect.Effect<unknown, unknown>) =>
    Effect.runPromise(request),
  );
  signOutMock.mockReturnValue(Effect.succeed({ signedOut: true }));
  switchTenantMock.mockReturnValue(Effect.succeed({ selectedTenantId: 'tenant-2' }));
});

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

test('anonymous home contains exactly one localized login link and no module list', () => {
  render(<HomeView initialModel={{ state: 'anonymous' }} />);

  const link = screen.getByRole('link', { name: 'Login' });
  expect(link.getAttribute('href')).toBe('/en/login');
  expect(screen.getAllByRole('link')).toHaveLength(1);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('list')).toBeNull();
  expect(screen.queryByRole('complementary')).toBeNull();
  expect(screen.queryByRole('banner')).toBeNull();
  expect(document.body.textContent?.trim()).toBe('Login');
});

test('authenticated home preserves identity and renders one ordered semantic active list', () => {
  render(<HomeView initialModel={authenticatedModel()} />);

  expect(screen.getAllByText('Ada Lovelace')).toHaveLength(2);
  expect(screen.getByText('ada@example.test')).toBeTruthy();
  expect(screen.getByText('principal-1')).toBeTruthy();
  expect(screen.getByText('tenant-1')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Ada Lovelace' })).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/en/');
  expect(screen.getByRole('link', { name: 'future-generated' }).getAttribute('href')).toBe(
    '/en/future-generated',
  );
  expect(screen.getByRole('link', { name: 'testing1' }).getAttribute('href')).toBe('/en/testing1');
  const list = screen.getByRole('list', { name: 'Active MicroVerticals' });
  expect(list.querySelectorAll('li')).toHaveLength(2);
  expect([...list.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
    'future-generated: Active',
    'testing1: Active',
  ]);
  expect(document.body.textContent).not.toContain('password');
  expect(document.body.textContent).not.toContain('token');
});

test('zero active modules renders the same empty list without additional content', () => {
  render(
    <HomeView
      initialModel={authenticatedModel({
        items: [],
        state: 'available',
      })}
    />,
  );

  const list = screen.getByRole('list', { name: 'Active MicroVerticals' });
  expect(list.querySelectorAll('li')).toHaveLength(0);
  expect(screen.queryByText('Active MicroVerticals are temporarily unavailable.')).toBeNull();
  expect(screen.getAllByRole('link')).toHaveLength(1);
});

test('unavailable module read retains identity, an empty associated list, and localized feedback', () => {
  render(
    <HomeView
      initialModel={authenticatedModel({
        items: [],
        state: 'unavailable',
      })}
    />,
  );

  expect(screen.getAllByText('Ada Lovelace')).toHaveLength(2);
  const list = screen.getByRole('list', { name: 'Active MicroVerticals' });
  expect(list.querySelectorAll('li')).toHaveLength(0);
  expect(list.getAttribute('aria-describedby')).toBe('active-modules-unavailable');
  expect(screen.getByText('Active MicroVerticals are temporarily unavailable.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Ada Lovelace' })).toBeTruthy();
  expect(screen.getByRole('complementary', { name: 'Dashboard sidebar' })).toBeTruthy();
});

test('the list contains no inactive, foreign-tenant, or non-installed module values', () => {
  render(<HomeView initialModel={authenticatedModel()} />);

  const content = screen.getByRole('list', { name: 'Active MicroVerticals' }).textContent ?? '';
  for (const excluded of [
    'inactive',
    'read_only',
    'suspended',
    'quarantined',
    'deprecated',
    'archived',
    'foreign-tenant',
    'stale-non-installed',
  ]) {
    expect(content).not.toContain(excluded);
  }
});

test('successful logout removes identity and list together', async () => {
  const user = userEvent.setup();
  render(<HomeView initialModel={authenticatedModel()} />);

  await user.click(screen.getByRole('button', { name: 'Ada Lovelace' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Logout' }));
  expect(signOutMock).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('link', { name: 'Login' })).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('list')).toBeNull();
  expect(screen.queryByRole('complementary')).toBeNull();
  expect(screen.queryByRole('banner')).toBeNull();
});

test('failed logout preserves identity and list while exposing the existing retry', async () => {
  const user = userEvent.setup();
  runEffectRequestMock.mockImplementationOnce(() => Promise.reject(new Error('unavailable')));
  render(<HomeView initialModel={authenticatedModel()} />);

  await user.click(screen.getByRole('button', { name: 'Ada Lovelace' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Logout' }));
  expect(screen.getAllByText('Ada Lovelace')).toHaveLength(2);
  expect(screen.getByText('Logout failed. Try again.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Ada Lovelace' })).toBeTruthy();
  expect(screen.getByRole('list', { name: 'Active MicroVerticals' })).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Ada Lovelace' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Logout' }));
  expect(signOutMock).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('link', { name: 'Login' })).toBeTruthy();
});

test('pending logout keeps one disabled command and prevents duplicate invocation', async () => {
  const logoutRequest = Promise.withResolvers<{ signedOut: true }>();
  runEffectRequestMock.mockImplementationOnce(() => logoutRequest.promise);
  const user = userEvent.setup();
  render(<HomeView initialModel={authenticatedModel()} />);

  await user.click(screen.getByRole('button', { name: 'Ada Lovelace' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Logout' }));
  expect(signOutMock).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole('button', { name: 'Ada Lovelace' }));
  const pendingCommand = await screen.findByRole('menuitem', { name: 'Logging out…' });
  expect(pendingCommand.getAttribute('aria-disabled')).toBe('true');
  await user.click(pendingCommand);
  expect(signOutMock).toHaveBeenCalledTimes(1);

  logoutRequest.resolve({ signedOut: true });
  expect(await screen.findByRole('link', { name: 'Login' })).toBeTruthy();
});

test('dispatches one exact tenant target, keeps old context pending, and reloads after success', async () => {
  const tenantRequest = Promise.withResolvers<{ selectedTenantId: string }>();
  switchTenantMock.mockImplementationOnce(() => Effect.promise(() => tenantRequest.promise));
  const user = userEvent.setup();
  render(<HomeView initialModel={authenticatedModel()} />);

  await user.click(screen.getByRole('combobox', { name: 'Current tenant' }));
  await user.click(await screen.findByRole('option', { name: 'Zeta tenant' }));
  expect(switchTenantMock).toHaveBeenCalledWith({ tenantId: 'tenant-2' }, { locale: 'en' });
  expect(switchTenantMock).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Switching tenant…')).toBeTruthy();
  expect(screen.getByText('tenant-1')).toBeTruthy();
  expect(navigateMock).not.toHaveBeenCalled();
  const pendingSelect = screen.getByRole('combobox', { name: 'Current tenant' });
  expect(pendingSelect.hasAttribute('disabled')).toBe(true);
  await user.click(pendingSelect);
  expect(switchTenantMock).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(switchTenantMock.mock.calls)).not.toMatch(
    /password|credential|session|token/iu,
  );

  tenantRequest.resolve({ selectedTenantId: 'tenant-2' });
  await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ reloadDocument: true, to: '.' }));
});

test('suppresses selecting the already current tenant', async () => {
  const user = userEvent.setup();
  render(<HomeView initialModel={authenticatedModel()} />);

  await user.click(screen.getByRole('combobox', { name: 'Current tenant' }));
  await user.click(await screen.findByRole('option', { name: 'Alpha tenant' }));

  expect(switchTenantMock).not.toHaveBeenCalled();
  expect(runEffectRequestMock).not.toHaveBeenCalled();
});

test('retains the prior tenant after failure and succeeds on retry', async () => {
  switchTenantMock.mockImplementationOnce(() =>
    Effect.fail({ _tag: 'HttpClientError' } as SwitchTenantClientError),
  );
  const user = userEvent.setup();
  render(<HomeView initialModel={authenticatedModel()} />);

  await user.click(screen.getByRole('combobox', { name: 'Current tenant' }));
  await user.click(await screen.findByRole('option', { name: 'Zeta tenant' }));
  expect(await screen.findByText('Tenant switching failed. Try again.')).toBeTruthy();
  expect(screen.getAllByText('Alpha tenant').length).toBeGreaterThan(0);
  expect(screen.getByText('tenant-1')).toBeTruthy();
  expect(navigateMock).not.toHaveBeenCalled();

  await user.click(screen.getByRole('combobox', { name: 'Current tenant' }));
  await user.click(await screen.findByRole('option', { name: 'Zeta tenant' }));
  await waitFor(() => expect(navigateMock).toHaveBeenCalledTimes(1));
  expect(switchTenantMock).toHaveBeenCalledTimes(2);
});

test('reloads stale authenticated chrome when switching reports an anonymous session', async () => {
  switchTenantMock.mockImplementationOnce(() =>
    Effect.fail({
      _tag: 'TenantAuthenticationRequiredProblem',
    } as SwitchTenantClientError),
  );
  const user = userEvent.setup();
  render(<HomeView initialModel={authenticatedModel()} />);

  await user.click(screen.getByRole('combobox', { name: 'Current tenant' }));
  await user.click(await screen.findByRole('option', { name: 'Zeta tenant' }));
  await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ reloadDocument: true, to: '.' }));
  expect(screen.queryByText('Tenant switching failed. Try again.')).toBeNull();
});
