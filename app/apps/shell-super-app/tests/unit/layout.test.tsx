import { Menu as ActualMenu } from '@techsio/ui-kit/molecules/menu' with {
  rstest: 'importActual',
};
import { Select as ActualSelect } from '@techsio/ui-kit/molecules/select' with {
  rstest: 'importActual',
};
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect } from 'effect';
import { afterEach, expect, it, rstest, test } from 'effect-rstest';
import type { HelmetProps } from '@modern-js/runtime/head';
import type { ComponentProps, ReactNode } from 'react';

import { AppIdSchema } from '../../shared/api';
import { ultramodernUiMarker } from '../../shared/ultramodern-build.ts';
import Layout from '../../src/routes/layout';
import { AuthenticatedDashboardLayout, buildShellNavigation } from '../../src/routes/shell-frame';

type HtmlAttributes = NonNullable<HelmetProps['htmlAttributes']>;

interface RouterStateDouble {
  readonly location: { readonly pathname: string };
  readonly resolvedLocation?: { readonly pathname: string };
}

interface RouterStateSlot {
  current: RouterStateDouble | null;
}

const settledRouterState: RouterStateDouble = {
  location: { pathname: '/en' },
  resolvedLocation: { pathname: '/en' },
};

const { accountMenuSelectHandlers, helmetHtmlAttributes, routerState, tenantValueChangeHandlers } = rstest.hoisted(
  () => {
    const accountHandlers: ComponentProps<typeof ActualMenu>['onSelect'][] = [];
    const htmlAttributes: HtmlAttributes[] = [];
    const tenantHandlers: ComponentProps<typeof ActualSelect>['onValueChange'][] = [];
    const pendingRouterState: RouterStateSlot = { current: null };
    return {
      accountMenuSelectHandlers: accountHandlers,
      helmetHtmlAttributes: htmlAttributes,
      routerState: pendingRouterState,
      tenantValueChangeHandlers: tenantHandlers,
    };
  },
);

rstest.mock('@modern-js/runtime/head', () => ({
  Helmet: ({ htmlAttributes }: Pick<HelmetProps, 'htmlAttributes'>) => {
    if (htmlAttributes !== undefined) {
      helmetHtmlAttributes.push(htmlAttributes);
    }
    return null;
  },
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  Outlet: () => <main>Current route</main>,
  useNavigate: () => () => Promise.resolve(),
  useRouter: () => ({ matchRoutes: () => [], preloadRoute: () => Promise.resolve(), routesById: {} }),
  useRouterState: ({ select }: { readonly select: (state: RouterStateDouble) => string | undefined }) =>
    select(routerState.current ?? settledRouterState),
}));

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  Link: ({
    activeOptions: _activeOptions,
    children,
    to,
    ...props
  }: Omit<ComponentProps<'a'>, 'href'> & {
    activeOptions?: unknown;
    children: ReactNode;
    to: string;
  }) => (
    <a href={`/en${to === '/' ? '/' : to}`} {...props}>
      {children}
    </a>
  ),
  useModernI18n: () => ({
    language: 'en',
    t: (key: string) =>
      ({
        'shell.auth.logout.action': 'Logout',
        'shell.auth.logout.pending': 'Logging out…',
        'shell.dashboard.account.label': 'Account menu',
        'shell.dashboard.brand': 'OntOS',
        'shell.dashboard.breadcrumb.home': 'Back to home',
        'shell.dashboard.breadcrumb.label': 'Breadcrumb',
        'shell.dashboard.header.label': 'Dashboard header',
        'shell.dashboard.legalEntity.accessibleLabel': 'Current legal entity',
        'shell.dashboard.legalEntity.failed': 'Legal entity switching failed. Try again.',
        'shell.dashboard.legalEntity.pending': 'Switching legal entity…',
        'shell.dashboard.legalEntity.placeholder': 'Select a legal entity',
        'shell.dashboard.legalEntity.unavailable': 'Legal entity choices are temporarily unavailable.',
        'shell.dashboard.navigation.groups.commerce': 'E-commerce',
        'shell.dashboard.navigation.groups.facility': 'Facility operations',
        'shell.dashboard.navigation.groups.finance': 'Finance',
        'shell.dashboard.navigation.groups.other': 'Other modules',
        'shell.dashboard.navigation.groups.realEstate': 'Real estate and leases',
        'shell.dashboard.navigation.groups.sales': 'Sales and CRM',
        'shell.dashboard.navigation.groups.settings': 'Settings',
        'shell.dashboard.navigation.groups.team': 'People and tasks',
        'shell.dashboard.navigation.home': 'Home',
        'shell.dashboard.navigation.label': 'Dashboard navigation',
        'shell.dashboard.navigation.pending': 'Loading page…',
        'shell.dashboard.sidebar.label': 'Dashboard sidebar',
        'shell.dashboard.tenant.accessibleLabel': 'Current tenant',
        'shell.dashboard.tenant.failed': 'Tenant switching failed. Try again.',
        'shell.dashboard.tenant.pending': 'Switching tenant…',
        'shell.dashboard.tenant.unavailable': 'Tenant choices are temporarily unavailable.',
        'shell.modules.discovery.incompatible': 'Incompatible module deployment',
        'shell.modules.discovery.revoked': 'Module revoked',
        'shell.modules.discovery.timeout': 'Module deployment timed out',
        'shell.modules.discovery.unavailable': 'Module deployment unavailable',
        'shell.profile.menu': 'Profile',
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
    if (props.name === 'tenant') {
      tenantValueChangeHandlers.push(props.onValueChange);
    }
    return <ActualSelect {...props} />;
  }, ActualSelect),
}));

const identity = {
  displayName: 'Ada Lovelace',
  email: 'ada@example.test',
  principalId: 'principal-1',
  tenantId: 'tenant-1',
};

/** A composition navigation entry of a fixture module; the label is English in this test's language. */
const entry = (
  moduleId: string,
  page: string,
  groupKey: string,
  label: string,
  { enabled = true, href = `/${moduleId.replaceAll('.', '-')}/${page}` }: { enabled?: boolean; href?: string } = {},
) => ({
  enabled,
  entrypointKey: `${moduleId}.page.${page}`,
  groupKey,
  href,
  icon: 'icon-[mdi--view-grid-outline]' as const,
  label: { cs: `${label} (cs)`, en: label },
  moduleId,
  state: 'active' as const,
  unavailable: false,
});

const navigation = [
  entry('future-generated', 'records', 'shell.navigation.unlisted', 'Future generated', {
    href: '/modules/future-generated',
  }),
  entry('testing.one', 'records', 'shell.navigation.unlisted', 'Testing one', { href: '/modules/testing.one' }),
];
const homeTitle = 'Home';
const homeOverviewTitle = 'Home overview';
const noopLogout = rstest.fn();
const noopTenantChange = rstest.fn();
const unavailableDeploymentAppIds = {
  legacyCenter: AppIdSchema.make('legacy-center'),
  propertyRegistry: AppIdSchema.make('property-registry'),
  reportingCenter: AppIdSchema.make('reporting-center'),
};
const tenantProps = {
  currentLegalEntityId: 'legal-entity-1',
  currentTenantId: 'tenant-1',
  legalEntityChoices: [{ legalEntityId: 'legal-entity-1', legalName: 'Alpha entity' }],
  legalEntityState: 'available' as const,
  legalEntitySwitchFailed: false,
  legalEntitySwitchPending: false,
  onLegalEntityChange: rstest.fn(),
  onSearch: rstest.fn(),
  onTenantChange: noopTenantChange,
  tenantChoices: [
    { name: 'Alpha tenant', tenantId: 'tenant-1' },
    { name: 'Zeta tenant', tenantId: 'tenant-2' },
  ],
  tenantState: 'available' as const,
  tenantSwitchFailed: false,
  tenantSwitchPending: false,
  unavailableDeployments: [],
};
const testingWorkspaceTitle = 'Testing workspace';

afterEach(() => {
  cleanup();
  routerState.current = null;
  accountMenuSelectHandlers.length = 0;
  helmetHtmlAttributes.length = 0;
  tenantValueChangeHandlers.length = 0;
});

test('selects the light Akros ui-kit theme on the server-rendered html element', () => {
  render(<Layout />);

  expect(helmetHtmlAttributes.at(-1)).toEqual({ className: 'light', 'data-theme': 'akros' });
});

test('leaves route content free of global user-perceivable UI', () => {
  render(<Layout />);

  expect(screen.getByRole('main').textContent).toBe('Current route');
  expect(screen.queryByRole('region')).toBeNull();
  expect(document.body.textContent?.trim()).toBe('Current route');
});

test('marks every server-rendered Shell route with its UI release marker', () => {
  const { container } = render(<Layout />);

  const root = container.querySelector<HTMLElement>('[data-app-id="shell-super-app"]');
  expect(root?.dataset['buildMarker']).toBe(ultramodernUiMarker.build);
});

test('renders the default Home dashboard contract and preserves page children', () => {
  render(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      identity={identity}
      logoutPending={false}
      navigation={navigation}
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

  const navigationElement = screen.getByRole('navigation', {
    name: 'Dashboard navigation',
  });
  const links = [...navigationElement.querySelectorAll('a')];
  expect(links.map((link) => link.textContent)).toEqual(['Home', 'Future generated', 'Testing one']);
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    '/en/',
    '/en/modules/future-generated',
    '/en/modules/testing.one',
  ]);
  expect(links[0]?.getAttribute('aria-current')).toBe('page');
  expect(links.slice(1).every((link) => link.tabIndex === 0)).toBe(true);
});

test('supports an alternate title and current MicroVertical without changing children', () => {
  render(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      currentModuleId="testing.one"
      identity={identity}
      logoutPending={false}
      navigation={navigation}
      onLogout={noopLogout}
      title={testingWorkspaceTitle}
    >
      <p>Stable child content</p>
    </AuthenticatedDashboardLayout>,
  );

  expect(screen.getByRole('heading', { level: 1, name: 'Testing workspace' })).toBeTruthy();
  expect(screen.getByText('Stable child content')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Home' }).hasAttribute('aria-current')).toBe(false);
  expect(screen.getByRole('link', { name: 'Testing one' }).getAttribute('aria-current')).toBe('page');
});

test('supports module pages with their own heading and preserves their content', () => {
  render(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      currentModuleId="testing.one"
      identity={identity}
      logoutPending={false}
      navigation={navigation}
      onLogout={noopLogout}
    >
      <section>Module content</section>
    </AuthenticatedDashboardLayout>,
  );

  expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  expect(screen.getByText('Module content')).toBeTruthy();
});

test('keeps Home as the only navigation link when no active modules are supplied', () => {
  render(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      identity={identity}
      logoutPending={false}
      navigation={[]}
      onLogout={noopLogout}
      title={homeTitle}
    >
      Content
    </AuthenticatedDashboardLayout>,
  );

  expect(screen.getByRole('navigation', { name: 'Dashboard navigation' }).querySelectorAll('a')).toHaveLength(1);
});

test('shows failed installed deployments as disabled identities with typed reasons', () => {
  render(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      identity={identity}
      logoutPending={false}
      navigation={navigation}
      onLogout={noopLogout}
      title={homeTitle}
      unavailableDeployments={[
        {
          appId: unavailableDeploymentAppIds.propertyRegistry,
          reason: 'timeout',
          status: 'unavailable',
        },
        {
          appId: unavailableDeploymentAppIds.reportingCenter,
          reason: 'incompatible',
          status: 'unavailable',
        },
        { appId: unavailableDeploymentAppIds.legacyCenter, status: 'revoked' },
      ]}
    >
      Content
    </AuthenticatedDashboardLayout>,
  );

  expect(screen.getByText('property-registry')).toBeTruthy();
  expect(screen.getByText('Module deployment timed out')).toBeTruthy();
  expect(screen.getByText('reporting-center')).toBeTruthy();
  expect(screen.getByText('Incompatible module deployment')).toBeTruthy();
  expect(screen.getByText('legacy-center')).toBeTruthy();
  expect(screen.getByText('Module revoked')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'property-registry' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'reporting-center' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'legacy-center' })).toBeNull();
});

it.effect('renders the account Menu last and dispatches only the logout command by keyboard', () =>
  Effect.gen(function* accountKeyboardLogout() {
    const onLogout = rstest.fn();
    const user = userEvent.setup();
    render(
      <AuthenticatedDashboardLayout
        {...tenantProps}
        identity={identity}
        logoutPending={false}
        navigation={navigation}
        onLogout={onLogout}
        title={homeTitle}
      >
        Content
      </AuthenticatedDashboardLayout>,
    );

    const header = document.querySelector('header[aria-label="Dashboard header"]');
    const trigger = screen.getByRole('button', { name: 'Ada Lovelace' });
    expect(header?.lastElementChild?.contains(trigger)).toBe(true);
    const accountMenu = header?.querySelector<HTMLElement>(':scope > :last-child');
    expect(accountMenu?.dataset['position']).toBe('end');

    trigger.focus();
    yield* Effect.promise(() => user.keyboard('{Enter}'));
    expect(yield* Effect.promise(() => screen.findByRole('menuitem', { name: 'Profile' }))).toBeTruthy();
    const logout = screen.getByRole('menuitem', { name: 'Logout' });
    yield* Effect.promise(() => user.keyboard('{End}'));
    expect(screen.getByRole('menu').getAttribute('aria-activedescendant')).toBe(logout.id);
    yield* Effect.promise(() => user.keyboard('{Enter}'));
    expect(onLogout).toHaveBeenCalledTimes(1);

    accountMenuSelectHandlers.at(-1)?.({ value: 'unexpected' });
    expect(onLogout).toHaveBeenCalledTimes(1);
  }),
);

it.effect('retains the account trigger and profile item while disabling logout when pending', () =>
  Effect.gen(function* pendingLogoutCommand() {
    const onLogout = rstest.fn();
    const user = userEvent.setup();
    render(
      <AuthenticatedDashboardLayout
        {...tenantProps}
        identity={identity}
        logoutPending
        navigation={navigation}
        onLogout={onLogout}
        title={homeTitle}
      >
        Content
      </AuthenticatedDashboardLayout>,
    );

    const trigger = screen.getByRole('button', { name: 'Ada Lovelace' });
    yield* Effect.promise(() => user.click(trigger));
    const command = yield* Effect.promise(() => screen.findByRole('menuitem', { name: 'Logging out…' }));
    expect(screen.getByRole('menuitem', { name: 'Profile' }).getAttribute('aria-disabled')).not.toBe('true');
    expect(command.getAttribute('aria-disabled')).toBe('true');
    yield* Effect.promise(() => user.click(command));
    expect(onLogout).not.toHaveBeenCalled();
  }),
);

it.effect('renders complete ordered tenant items and dispatches keyboard selection once', () =>
  Effect.gen(function* tenantKeyboardSelection() {
    const onTenantChange = rstest.fn();
    const user = userEvent.setup();
    render(
      <AuthenticatedDashboardLayout
        {...tenantProps}
        identity={identity}
        logoutPending={false}
        navigation={navigation}
        onLogout={noopLogout}
        onTenantChange={onTenantChange}
        title={homeTitle}
      >
        Content
      </AuthenticatedDashboardLayout>,
    );

    const trigger = screen.getByRole('combobox', { name: 'Current tenant' });
    yield* Effect.promise(() => user.click(trigger));
    const options = yield* Effect.promise(() => screen.findAllByRole('option'));
    expect(options.map((option) => option.textContent)).toEqual(['Alpha tenant', 'Zeta tenant']);
    expect(options.map((option) => option.dataset['value'])).toEqual(['tenant-1', 'tenant-2']);
    expect(options.every((option) => option.querySelector('span') !== null)).toBe(true);
    yield* Effect.promise(() => user.keyboard('{ArrowDown}{Enter}'));
    expect(onTenantChange).toHaveBeenCalledWith('tenant-2');
    expect(onTenantChange).toHaveBeenCalledTimes(1);

    tenantValueChangeHandlers.at(-1)?.({
      items: [tenantProps.tenantChoices[0]],
      value: ['tenant-1'],
    });
    tenantValueChangeHandlers.at(-1)?.({ items: [], value: [] });
    expect(onTenantChange).toHaveBeenCalledTimes(1);
  }),
);

test('disables unavailable, one-choice, and pending tenant states with associated feedback', () => {
  const { rerender } = render(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      identity={identity}
      logoutPending={false}
      navigation={navigation}
      onLogout={noopLogout}
      tenantChoices={tenantProps.tenantChoices.slice(0, 1)}
      title={homeTitle}
    >
      Content
    </AuthenticatedDashboardLayout>,
  );
  expect(screen.getByRole('combobox', { name: 'Current tenant' }).hasAttribute('disabled')).toBe(true);

  rerender(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      identity={identity}
      logoutPending={false}
      navigation={navigation}
      onLogout={noopLogout}
      tenantChoices={[]}
      title={homeTitle}
    >
      Content
    </AuthenticatedDashboardLayout>,
  );
  expect(screen.getByRole('combobox', { name: 'Current tenant' }).hasAttribute('disabled')).toBe(true);

  rerender(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      identity={identity}
      logoutPending={false}
      navigation={navigation}
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
      identity={identity}
      logoutPending={false}
      navigation={navigation}
      onLogout={noopLogout}
      tenantSwitchPending
      title={homeTitle}
    >
      Content
    </AuthenticatedDashboardLayout>,
  );
  expect(screen.getByRole('combobox', { name: 'Current tenant' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('Switching tenant…')).toBeTruthy();
});

test('associates failed tenant feedback and keeps multiple choices operable', () => {
  render(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      identity={identity}
      logoutPending={false}
      navigation={navigation}
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

test('names the legal-entity selector by its own label and keeps a sole choice operable', () => {
  const { rerender } = render(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      identity={identity}
      logoutPending={false}
      navigation={navigation}
      onLogout={noopLogout}
      title={homeTitle}
    >
      Content
    </AuthenticatedDashboardLayout>,
  );

  const legalEntity = screen.getByRole('combobox', {
    name: 'Current legal entity',
  });
  expect(legalEntity.hasAttribute('aria-label')).toBe(false);
  expect(legalEntity.hasAttribute('aria-describedby')).toBe(false);
  expect(legalEntity.hasAttribute('disabled')).toBe(false);
  expect(screen.getByRole('combobox', { name: 'Current tenant' }).getAttribute('aria-label')).toBe('Current tenant');
  expect(screen.queryByText('Select a legal entity')).toBeNull();

  const { currentLegalEntityId: _selectedLegalEntityId, ...unselectedLegalEntityProps } = tenantProps;
  rerender(
    <AuthenticatedDashboardLayout
      {...unselectedLegalEntityProps}
      identity={identity}
      logoutPending={false}
      navigation={navigation}
      onLogout={noopLogout}
      title={homeTitle}
    >
      Content
    </AuthenticatedDashboardLayout>,
  );

  expect(screen.getByText('Select a legal entity')).toBeTruthy();
});

interface LegalEntitySelectorStateCase {
  readonly disabled: boolean;
  readonly name: string;
  readonly overrides: Partial<
    Pick<
      ComponentProps<typeof AuthenticatedDashboardLayout>,
      'legalEntityState' | 'legalEntitySwitchFailed' | 'legalEntitySwitchPending'
    >
  >;
  readonly statusText: string;
}

const legalEntitySelectorStateCases: LegalEntitySelectorStateCase[] = [
  {
    disabled: true,
    name: 'the legal entities are unavailable',
    overrides: { legalEntityState: 'unavailable' },
    statusText: 'Legal entity choices are temporarily unavailable.',
  },
  {
    disabled: true,
    name: 'a legal-entity switch is pending',
    overrides: { legalEntitySwitchPending: true },
    statusText: 'Switching legal entity…',
  },
  {
    disabled: false,
    name: 'a legal-entity switch failed',
    overrides: { legalEntitySwitchFailed: true },
    statusText: 'Legal entity switching failed. Try again.',
  },
];

test.each(legalEntitySelectorStateCases)(
  'associates legal-entity feedback with its own selector when $name',
  ({ disabled, overrides, statusText }) => {
    render(
      <AuthenticatedDashboardLayout
        {...tenantProps}
        {...overrides}
        identity={identity}
        logoutPending={false}
        navigation={navigation}
        onLogout={noopLogout}
        title={homeTitle}
      >
        Content
      </AuthenticatedDashboardLayout>,
    );

    const legalEntity = screen.getByRole('combobox', {
      name: 'Current legal entity',
    });
    expect(legalEntity.hasAttribute('disabled')).toBe(disabled);
    expect(legalEntity.getAttribute('aria-describedby')).toBe('legal-entity-switch-status');
    expect(screen.getByText(statusText)).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Current tenant' }).getAttribute('aria-describedby')).toBeNull();
  },
);

const estate = entry('fixture.estate', 'records', 'shell.navigation.real-estate', 'Properties');
const leases = entry('fixture.leases', 'records', 'shell.navigation.real-estate', 'Leases and stays');
const agreements = entry('fixture.agreements', 'records', 'shell.navigation.sales', 'Contracts and signatures');
const orders = entry('fixture.shop', 'orders', 'shell.navigation.commerce', 'Orders');
const products = entry('fixture.shop', 'products', 'shell.navigation.commerce', 'Products and stock');
const tasks = entry('fixture.tasks', 'records', 'shell.navigation.team', 'Tasks');
const invoices = entry('fixture.invoices', 'records', 'shell.navigation.finance', 'Invoices');

test('places module destinations in the Shell sections they declare, in composition order', () => {
  render(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      currentEntrypointKey="fixture.shop.page.products"
      currentModuleId="fixture.shop"
      identity={identity}
      logoutPending={false}
      navigation={[estate, agreements, leases, ...navigation, orders, products, tasks]}
      onLogout={noopLogout}
    >
      <section>Products</section>
    </AuthenticatedDashboardLayout>,
  );
  const navigationElement = screen.getByRole('navigation', { name: 'Dashboard navigation' });
  const links = [...navigationElement.querySelectorAll('a')];
  expect(links.map((link) => link.textContent)).toEqual([
    'Home',
    'Properties',
    'Leases and stays',
    'Contracts and signatures',
    'Orders',
    'Products and stock',
    'Tasks',
    'Future generated',
    'Testing one',
  ]);
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    '/en/',
    '/en/fixture-estate/records',
    '/en/fixture-leases/records',
    '/en/fixture-agreements/records',
    '/en/fixture-shop/orders',
    '/en/fixture-shop/products',
    '/en/fixture-tasks/records',
    '/en/modules/future-generated',
    '/en/modules/testing.one',
  ]);
  expect(links.filter((link) => link.getAttribute('aria-current') === 'page').map((link) => link.textContent)).toEqual([
    'Products and stock',
  ]);
  expect([...navigationElement.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual([
    'Real estate and leases',
    'Sales and CRM',
    'E-commerce',
    'People and tasks',
    'Other modules',
  ]);
  expect(navigationElement.textContent).not.toContain('(cs)');
  expect(screen.getByRole('navigation', { name: 'Breadcrumb' }).textContent).toBe('E-commerceProducts and stock');
});

test('shows the Czech label a module declares for a Czech page', () => {
  const model = buildShellNavigation(
    { language: 'cs', navigation: [estate], unavailableDeployments: [] },
    (key) => key,
  );
  expect(model.groups.flatMap(({ links }) => links.map(({ label }) => label))).toEqual(['Properties (cs)']);
});

const navigationText = () => screen.getByRole('navigation', { name: 'Dashboard navigation' }).textContent;

test('replaces destinations when the selected entity composition changes', () => {
  const props = { ...tenantProps, identity, logoutPending: false, onLogout: noopLogout };
  const { rerender } = render(
    <AuthenticatedDashboardLayout {...props} navigation={[orders, products, agreements]}>
      Content
    </AuthenticatedDashboardLayout>,
  );
  expect(navigationText()).toContain('Products and stock');
  expect(navigationText()).not.toContain('Properties');
  rerender(
    <AuthenticatedDashboardLayout
      {...props}
      currentLegalEntityId="legal-entity-rental"
      navigation={[estate, agreements, invoices]}
    >
      Content
    </AuthenticatedDashboardLayout>,
  );
  expect(navigationText()).toContain('Properties');
  expect(navigationText()).toContain('Contracts and signatures');
  expect(navigationText()).toContain('Invoices');
  expect(navigationText()).not.toContain('Products and stock');
  expect(navigationText()).not.toContain('Orders');
});

test('keeps unavailable destinations visible without links', () => {
  render(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      identity={identity}
      logoutPending={false}
      navigation={[{ ...invoices, enabled: false }]}
      onLogout={noopLogout}
    >
      <section>Current content</section>
    </AuthenticatedDashboardLayout>,
  );
  const navigationElement = screen.getByRole('navigation', { name: 'Dashboard navigation' });
  expect([...navigationElement.querySelectorAll('a')].map((link) => link.textContent)).toEqual(['Home']);
  expect(screen.getByText('Invoices')).toBeTruthy();
  expect([...navigationElement.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual(['Finance']);
  expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
});

const currentLinkNames = () =>
  [...screen.getByRole('navigation', { name: 'Dashboard navigation' }).querySelectorAll('a')]
    .filter((link) => link.getAttribute('aria-current') === 'page')
    .map((link) => link.textContent);

const customersAndContacts = [
  entry('fixture.parties', 'customers', 'shell.navigation.sales', 'Customers'),
  entry('fixture.parties', 'contacts', 'shell.navigation.sales', 'Contacts'),
  entry('fixture.staff', 'records', 'shell.navigation.team', 'Employees'),
];

test('marks only the page own destination current when two links share its module', () => {
  render(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      currentEntrypointKey="fixture.parties.page.contacts"
      currentModuleId="fixture.parties"
      identity={identity}
      logoutPending={false}
      navigation={customersAndContacts}
      onLogout={noopLogout}
    >
      <section>Contacts</section>
    </AuthenticatedDashboardLayout>,
  );

  expect(currentLinkNames()).toEqual(['Contacts']);
});

test('marks the sole destination of a module current on its other pages', () => {
  render(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      currentEntrypointKey="fixture.staff.page.detail"
      currentModuleId="fixture.staff"
      identity={identity}
      logoutPending={false}
      navigation={customersAndContacts}
      onLogout={noopLogout}
    >
      <section>Employee</section>
    </AuthenticatedDashboardLayout>,
  );

  expect(currentLinkNames()).toEqual(['Employees']);
});

test('hides the previous page and marks the destination while the next page loads', () => {
  routerState.current = {
    location: { pathname: '/en/fixture-parties/contacts' },
    resolvedLocation: { pathname: '/en/fixture-staff/records' },
  };
  const employeesOverviewTitle = 'Employees overview';
  render(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      currentEntrypointKey="fixture.staff.page.records"
      currentModuleId="fixture.staff"
      identity={identity}
      logoutPending={false}
      navigation={customersAndContacts}
      onLogout={noopLogout}
      title={employeesOverviewTitle}
    >
      <section>Employee list</section>
    </AuthenticatedDashboardLayout>,
  );

  expect(screen.getByText('Loading page…')).toBeTruthy();
  expect(screen.getByText('Employee list').closest('.hidden')).not.toBeNull();
  expect(screen.getByRole('heading', { level: 1, name: employeesOverviewTitle }).closest('.hidden')).not.toBeNull();
  expect(currentLinkNames()).toEqual(['Contacts']);
  expect(screen.getByRole('navigation', { name: 'Breadcrumb' }).textContent).toBe('Sales and CRMContacts');
});

test('keeps the page visible when only search parameters or loader data refresh', () => {
  render(
    <AuthenticatedDashboardLayout
      {...tenantProps}
      currentEntrypointKey="fixture.staff.page.records"
      currentModuleId="fixture.staff"
      identity={identity}
      logoutPending={false}
      navigation={customersAndContacts}
      onLogout={noopLogout}
    >
      <section>Employee list</section>
    </AuthenticatedDashboardLayout>,
  );

  expect(screen.queryByText('Loading page…')).toBeNull();
  expect(screen.getByText('Employee list').closest('.hidden')).toBeNull();
  expect(currentLinkNames()).toEqual(['Employees']);
});
