import { afterEach, beforeEach, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomeView } from '../../../../src/routes/[lang]/page.tsx';
import type { HomePageModel } from '../../../../src/routes/[lang]/page.data.ts';

const { runEffectRequestMock, signOutMock } = rstest.hoisted(() => ({
  runEffectRequestMock: rstest.fn(() => Promise.resolve({ signedOut: true })),
  signOutMock: rstest.fn(() => ({ operation: 'signOut' })),
}));

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
  'shell.modules.active.item': '{{moduleKey}}: {{state}}',
  'shell.modules.active.label': 'Active MicroVerticals',
  'shell.modules.active.unavailable': 'Active MicroVerticals are temporarily unavailable.',
  'shell.modules.state.active': 'Active',
};

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
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

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  runEffectRequest: runEffectRequestMock,
  signOut: signOutMock,
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
});

beforeEach(() => {
  runEffectRequestMock.mockImplementation(() => Promise.resolve({ signedOut: true }));
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
  expect(document.body.textContent?.trim()).toBe('Login');
});

test('authenticated home preserves identity and renders one ordered semantic active list', () => {
  render(<HomeView initialModel={authenticatedModel()} />);

  expect(screen.getByText('Ada Lovelace')).toBeTruthy();
  expect(screen.getByText('ada@example.test')).toBeTruthy();
  expect(screen.getByText('principal-1')).toBeTruthy();
  expect(screen.getByText('tenant-1')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Logout' })).toHaveLength(1);
  expect(screen.queryByRole('link')).toBeNull();
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
  expect(screen.queryByRole('link')).toBeNull();
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

  expect(screen.getByText('Ada Lovelace')).toBeTruthy();
  const list = screen.getByRole('list', { name: 'Active MicroVerticals' });
  expect(list.querySelectorAll('li')).toHaveLength(0);
  expect(list.getAttribute('aria-describedby')).toBe('active-modules-unavailable');
  expect(screen.getByText('Active MicroVerticals are temporarily unavailable.')).toBeTruthy();
  expect(screen.getAllByRole('button')).toHaveLength(1);
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

  await user.click(screen.getByRole('button', { name: 'Logout' }));
  expect(signOutMock).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('link', { name: 'Login' })).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('list')).toBeNull();
});

test('failed logout preserves identity and list while exposing the existing retry', async () => {
  const user = userEvent.setup();
  runEffectRequestMock.mockImplementationOnce(() => Promise.reject(new Error('unavailable')));
  render(<HomeView initialModel={authenticatedModel()} />);

  await user.click(screen.getByRole('button', { name: 'Logout' }));
  expect(screen.getByText('Ada Lovelace')).toBeTruthy();
  expect(screen.getByText('Logout failed. Try again.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Logout' })).toBeTruthy();
  expect(screen.getByRole('list', { name: 'Active MicroVerticals' })).toBeTruthy();
});
