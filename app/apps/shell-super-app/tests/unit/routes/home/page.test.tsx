import { afterEach, beforeEach, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomeView } from '../../../../src/routes/[lang]/page.tsx';

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
    t: (key: string) => translations[key] ?? key,
  }),
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  runEffectRequest: runEffectRequestMock,
  signOut: signOutMock,
}));

beforeEach(() => {
  runEffectRequestMock.mockImplementation(() => Promise.resolve({ signedOut: true }));
});

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

test('anonymous home contains exactly one localized login link', () => {
  render(<HomeView initialSession={{ state: 'anonymous' }} />);

  const link = screen.getByRole('link', { name: 'Login' });
  expect(link.getAttribute('href')).toBe('/en/login');
  expect(screen.getAllByRole('link')).toHaveLength(1);
  expect(screen.queryByRole('button')).toBeNull();
  expect(document.body.textContent?.trim()).toBe('Login');
});

test('authenticated home exposes only safe identity fields and logout', () => {
  render(
    <HomeView
      initialSession={{
        identity: {
          displayName: 'Ada Lovelace',
          email: 'ada@example.test',
          principalId: 'principal-1',
          tenantId: 'tenant-1',
        },
        state: 'authenticated',
      }}
    />,
  );

  expect(screen.getByText('Ada Lovelace')).toBeTruthy();
  expect(screen.getByText('ada@example.test')).toBeTruthy();
  expect(screen.getByText('principal-1')).toBeTruthy();
  expect(screen.getByText('tenant-1')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Logout' })).toHaveLength(1);
  expect(screen.queryByRole('link')).toBeNull();
  expect(document.body.textContent).not.toContain('password');
  expect(document.body.textContent).not.toContain('token');
});

test('successful logout leaves only the login link', () => {
  const user = userEvent.setup();
  render(
    <HomeView
      initialSession={{
        identity: {
          displayName: 'Ada Lovelace',
          email: 'ada@example.test',
          principalId: 'principal-1',
          tenantId: 'tenant-1',
        },
        state: 'authenticated',
      }}
    />,
  );

  return user.click(screen.getByRole('button', { name: 'Logout' })).then(() => {
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Login' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

test('failed logout preserves identity and exposes a retry', () => {
  const user = userEvent.setup();
  runEffectRequestMock.mockImplementationOnce(() => Promise.reject(new Error('unavailable')));
  render(
    <HomeView
      initialSession={{
        identity: {
          displayName: 'Ada Lovelace',
          email: 'ada@example.test',
          principalId: 'principal-1',
          tenantId: 'tenant-1',
        },
        state: 'authenticated',
      }}
    />,
  );

  return user.click(screen.getByRole('button', { name: 'Logout' })).then(() => {
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('Logout failed. Try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Logout' })).toBeTruthy();
  });
});
