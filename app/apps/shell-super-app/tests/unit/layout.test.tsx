import { afterEach, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Menu as ActualMenu } from '@techsio/ui-kit/molecules/menu' with { rstest: 'importActual' };
import { Select as ActualSelect } from '@techsio/ui-kit/molecules/select' with {
  rstest: 'importActual',
};
import type { ComponentProps, ReactNode } from 'react';
import Layout from '../../src/routes/layout';
import { AuthenticatedDashboardLayout } from '../../src/routes/shell-frame';

const { accountMenuSelectHandlers, tenantValueChangeHandlers } = rstest.hoisted(() => ({
  accountMenuSelectHandlers: [] as (((details: { value: string }) => void) | undefined)[],
  tenantValueChangeHandlers: [] as ComponentProps<typeof ActualSelect>['onValueChange'][],
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
        'shell.dashboard.tenant.accessibleLabel': 'Current tenant',
        'shell.dashboard.tenant.failed': 'Tenant switching failed. Try again.',
        'shell.dashboard.tenant.pending': 'Switching tenant…',
        'shell.dashboard.tenant.unavailable': 'Tenant choices are temporarily unavailable.',
      })[key] ?? key,
  }),
}));

rstest.mock('@techsio/ui-kit/molecules/menu', () => ({
  Menu: (props: ComponentProps<typeof ActualMenu>) => {
    accountMenuSelectHandlers.push(props.onSelect);
    return <ActualMenu {...props} />;
  },
}));

rstest.mock('@techsio/ui-kit/molecules/select', () => ({
  Select: Object.assign((props: ComponentProps<typeof ActualSelect>) => {
    tenantValueChangeHandlers.push(props.onValueChange);
    return <ActualSelect {...props} />;
  }, ActualSelect),
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
const noopTenantChange = rstest.fn();
const tenantProps = {
  currentTenantId: 'tenant-1',
  onTenantChange: noopTenantChange,
  tenantChoices: [
    { name: 'Alpha tenant', tenantId: 'tenant-1' },
    { name: 'Zeta tenant', tenantId: 'tenant-2' },
  ],
  tenantState: 'available' as const,
  tenantSwitchFailed: false,
  tenantSwitchPending: false,
};
const testingWorkspaceTitle = 'Testing workspace';

afterEach(() => {
  cleanup();
  accountMenuSelectHandlers.length = 0;
  tenantValueChangeHandlers.length = 0;
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
      {...tenantProps}
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

  const tenantSelect = screen.getByRole('combobox', { name: 'Current tenant' });
  expect(tenantSelect.hasAttribute('disabled')).toBe(false);
  expect(screen.getAllByText('Alpha tenant').length).toBeGreaterThan(0);

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
      {...tenantProps}
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
      {...tenantProps}
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
      {...tenantProps}
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
      {...tenantProps}
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

test('renders complete ordered tenant items and dispatches keyboard selection once', async () => {
  const onTenantChange = rstest.fn();
  const user = userEvent.setup();
  render(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      activeModules={activeModules}
      identity={identity}
      logoutPending={false}
      onLogout={noopLogout}
      onTenantChange={onTenantChange}
      title={homeTitle}
    >
      Content
    </AuthenticatedDashboardLayout>,
  );

  const trigger = screen.getByRole('combobox', { name: 'Current tenant' });
  await user.click(trigger);
  const options = await screen.findAllByRole('option');
  expect(options.map((option) => option.textContent)).toEqual(['Alpha tenant', 'Zeta tenant']);
  expect(options.map((option) => option.dataset.value)).toEqual(['tenant-1', 'tenant-2']);
  expect(options.every((option) => option.querySelector('span') !== null)).toBe(true);
  await user.keyboard('{ArrowDown}{Enter}');
  expect(onTenantChange).toHaveBeenCalledWith('tenant-2');
  expect(onTenantChange).toHaveBeenCalledTimes(1);

  tenantValueChangeHandlers.at(-1)?.({
    items: [tenantProps.tenantChoices[0]],
    value: ['tenant-1'],
  });
  tenantValueChangeHandlers.at(-1)?.({ items: [], value: [] });
  expect(onTenantChange).toHaveBeenCalledTimes(1);
});

test('disables unavailable, one-choice, and pending tenant states with associated feedback', () => {
  const { rerender } = render(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      activeModules={activeModules}
      identity={identity}
      logoutPending={false}
      onLogout={noopLogout}
      tenantChoices={tenantProps.tenantChoices.slice(0, 1)}
      title={homeTitle}
    >
      Content
    </AuthenticatedDashboardLayout>,
  );
  expect(screen.getByRole('combobox', { name: 'Current tenant' }).hasAttribute('disabled')).toBe(
    true,
  );

  rerender(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      activeModules={activeModules}
      identity={identity}
      logoutPending={false}
      onLogout={noopLogout}
      tenantChoices={[]}
      title={homeTitle}
    >
      Content
    </AuthenticatedDashboardLayout>,
  );
  expect(screen.getByRole('combobox', { name: 'Current tenant' }).hasAttribute('disabled')).toBe(
    true,
  );

  rerender(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      activeModules={activeModules}
      identity={identity}
      logoutPending={false}
      onLogout={noopLogout}
      tenantState="unavailable"
      title={homeTitle}
    >
      Content
    </AuthenticatedDashboardLayout>,
  );
  const unavailable = screen.getByRole('combobox', { name: 'Current tenant' });
  expect(unavailable.hasAttribute('disabled')).toBe(true);
  expect(unavailable.getAttribute('aria-describedby')).toBe('tenant-switch-status');
  expect(screen.getByText('Tenant choices are temporarily unavailable.')).toBeTruthy();

  rerender(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      activeModules={activeModules}
      identity={identity}
      logoutPending={false}
      onLogout={noopLogout}
      tenantSwitchPending
      title={homeTitle}
    >
      Content
    </AuthenticatedDashboardLayout>,
  );
  expect(screen.getByRole('combobox', { name: 'Current tenant' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByText('Switching tenant…')).toBeTruthy();
});

test('associates failed tenant feedback and keeps multiple choices operable', () => {
  render(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      activeModules={activeModules}
      identity={identity}
      logoutPending={false}
      onLogout={noopLogout}
      tenantSwitchFailed
      title={homeTitle}
    >
      Content
    </AuthenticatedDashboardLayout>,
  );
  const trigger = screen.getByRole('combobox', { name: 'Current tenant' });
  expect(trigger.hasAttribute('disabled')).toBe(false);
  expect(trigger.getAttribute('aria-describedby')).toBe('tenant-switch-status');
  expect(trigger.getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByText('Tenant switching failed. Try again.')).toBeTruthy();
});
