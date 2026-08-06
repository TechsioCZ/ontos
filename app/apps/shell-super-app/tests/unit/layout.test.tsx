import { afterEach, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Menu as ActualMenu } from '@techsio/ui-kit/molecules/menu' with { rstest: 'importActual' };
import type { ComponentProps, ReactNode } from 'react';
import Layout from '../../src/routes/layout';
import { AuthenticatedDashboardLayout } from '../../src/routes/shell-frame';

const { accountMenuSelectHandlers } = rstest.hoisted(() => ({
  accountMenuSelectHandlers: [] as (((details: { value: string }) => void) | undefined)[],
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  Outlet: () => <main>Current route</main>,
}));

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
  useModernI18n: () => ({
    t: (key: string) =>
      ({
        'shell.auth.logout.action': 'Logout',
        'shell.auth.logout.pending': 'Logging out…',
        'shell.dashboard.account.label': 'Account menu',
        'shell.dashboard.brand': 'OntOS',
        'shell.dashboard.header.label': 'Dashboard header',
        'shell.dashboard.navigation.home': 'Home',
        'shell.dashboard.navigation.label': 'Dashboard navigation',
        'shell.dashboard.sidebar.label': 'Dashboard sidebar',
        'shell.dashboard.tenant.empty': 'Tenant switching unavailable',
        'shell.dashboard.tenant.label': 'Tenant',
      })[key] ?? key,
  }),
}));

rstest.mock('@techsio/ui-kit/molecules/menu', () => ({
  Menu: (props: ComponentProps<typeof ActualMenu>) => {
    accountMenuSelectHandlers.push(props.onSelect);
    return <ActualMenu {...props} />;
  },
}));

const identity = {
  displayName: 'Ada Lovelace',
  email: 'ada@example.test',
  principalId: 'principal-1',
  tenantId: 'tenant-1',
};

const activeModules = [
  { moduleKey: 'future-generated', state: 'active' as const },
  { moduleKey: 'testing.one', state: 'active' as const },
];
const homeTitle = 'Home';
const homeOverviewTitle = 'Home overview';
const noopLogout = rstest.fn();
const testingWorkspaceTitle = 'Testing workspace';

afterEach(() => {
  cleanup();
  accountMenuSelectHandlers.length = 0;
});

test('leaves route content free of global user-perceivable UI', () => {
  render(<Layout />);

  expect(screen.getByRole('main').textContent).toBe('Current route');
  expect(screen.queryByRole('region')).toBeNull();
  expect(document.body.textContent?.trim()).toBe('Current route');
});

test('renders the default Home dashboard contract and preserves page children', () => {
  render(
    <AuthenticatedDashboardLayout
      activeModules={activeModules}
      identity={identity}
      logoutPending={false}
      onLogout={noopLogout}
      title={homeOverviewTitle}
    >
      <section>Page-specific content</section>
    </AuthenticatedDashboardLayout>,
  );

  expect(screen.getByRole('complementary', { name: 'Dashboard sidebar' })).toBeTruthy();
  expect(screen.getByText('OntOS')).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1, name: 'Home overview' })).toBeTruthy();
  expect(screen.getByText('Page-specific content')).toBeTruthy();

  const tenantSelect = screen.getByRole('combobox', { name: 'Tenant' });
  expect(tenantSelect.hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('Tenant switching unavailable')).toBeTruthy();

  const navigation = screen.getByRole('navigation', { name: 'Dashboard navigation' });
  const links = [...navigation.querySelectorAll('a')];
  expect(links.map((link) => link.textContent)).toEqual([
    'Home',
    'future-generated',
    'testing.one',
  ]);
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    '/en/',
    '/en/future-generated',
    '/en/testing.one',
  ]);
  expect(links[0]?.getAttribute('aria-current')).toBe('page');
  expect(links.slice(1).every((link) => link.tabIndex === 0)).toBe(true);
  expect(navigation.textContent).not.toContain('inactive');
});

test('supports an alternate title and current MicroVertical without changing children', () => {
  render(
    <AuthenticatedDashboardLayout
      activeModules={activeModules}
      currentModuleKey="testing.one"
      identity={identity}
      logoutPending={false}
      onLogout={noopLogout}
      title={testingWorkspaceTitle}
    >
      <p>Stable child content</p>
    </AuthenticatedDashboardLayout>,
  );

  expect(screen.getByRole('heading', { level: 1, name: 'Testing workspace' })).toBeTruthy();
  expect(screen.getByText('Stable child content')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Home' }).hasAttribute('aria-current')).toBe(false);
  expect(screen.getByRole('link', { name: 'testing.one' }).getAttribute('aria-current')).toBe(
    'page',
  );
});

test('keeps Home as the only navigation link when no active modules are supplied', () => {
  render(
    <AuthenticatedDashboardLayout
      activeModules={[]}
      identity={identity}
      logoutPending={false}
      onLogout={noopLogout}
      title={homeTitle}
    >
      Content
    </AuthenticatedDashboardLayout>,
  );

  expect(
    screen.getByRole('navigation', { name: 'Dashboard navigation' }).querySelectorAll('a'),
  ).toHaveLength(1);
});

test('renders the account Menu last and dispatches only the logout command by keyboard', async () => {
  const onLogout = rstest.fn();
  const user = userEvent.setup();
  render(
    <AuthenticatedDashboardLayout
      activeModules={activeModules}
      identity={identity}
      logoutPending={false}
      onLogout={onLogout}
      title={homeTitle}
    >
      Content
    </AuthenticatedDashboardLayout>,
  );

  const header = document.querySelector('header[aria-label="Dashboard header"]');
  const trigger = screen.getByRole('button', { name: 'Ada Lovelace' });
  expect(header?.lastElementChild?.contains(trigger)).toBe(true);

  trigger.focus();
  await user.keyboard('{Enter}');
  const commands = await screen.findAllByRole('menuitem');
  expect(commands).toHaveLength(1);
  expect(commands[0]?.textContent).toBe('Logout');
  await user.keyboard('{ArrowDown}{Enter}');
  expect(onLogout).toHaveBeenCalledTimes(1);

  accountMenuSelectHandlers.at(-1)?.({ value: 'unexpected' });
  expect(onLogout).toHaveBeenCalledTimes(1);
});

test('retains the account trigger and disables the sole command while logout is pending', async () => {
  const onLogout = rstest.fn();
  const user = userEvent.setup();
  render(
    <AuthenticatedDashboardLayout
      activeModules={activeModules}
      identity={identity}
      logoutPending
      onLogout={onLogout}
      title={homeTitle}
    >
      Content
    </AuthenticatedDashboardLayout>,
  );

  const trigger = screen.getByRole('button', { name: 'Ada Lovelace' });
  await user.click(trigger);
  const command = await screen.findByRole('menuitem', { name: 'Logging out…' });
  expect(command.getAttribute('aria-disabled')).toBe('true');
  await user.click(command);
  expect(onLogout).not.toHaveBeenCalled();
});
