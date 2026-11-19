import { getDocumentCompositionRevision } from '@app/shared-contracts';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect, Schema } from 'effect';
import { afterEach, expect, it, rstest } from 'effect-rstest';

import {
  AppIdSchema,
  EntrypointKeySchema,
  GroupKeySchema,
  LegalEntityAccessForbiddenProblemSchema,
  LegalEntityIdSchema,
  ModuleIdSchema,
  PrincipalIdSchema,
  ResolvedModuleTargetSchema,
  ShellSearchResponseSchema,
  SignOutResponseSchema,
  SwitchLegalEntityResponseSchema,
  SwitchTenantResponseSchema,
  SwitchToTenantContextResponseSchema,
  TenantAccessForbiddenProblemSchema,
  TenantAuthenticationRequiredProblemSchema,
  TenantIdSchema,
} from '../../../../shared/browser-api.ts';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import type { ResolvedModuleTarget } from '../../../../shared/browser-api.ts';
import type { AuthenticatedHomePageModel, HomePageModel } from '../../../../src/routes/[lang]/home-page-model.ts';
import ShellHome from '../../../../src/routes/[lang]/page.tsx';
import { browserRuntime } from '../../../../src/runtime/browser-effect-runtime.ts';
import { makeShellBff } from '../../../support/shell-bff-double.ts';
import type { ShellBffEndpoint, ShellBffScript } from '../../../support/shell-bff-double.ts';
import { shellTestCopy } from '../../../support/shell-i18n.tsx';
import type { ShellLanguage } from '../../../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../../../support/shell-router.tsx';
import { makeFederationHost } from '../modules/federation-host.ts';

const copy = {
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
  'shell.dashboard.home.noAreas': 'You have not been assigned a role yet — ask your company administrator.',
  'shell.dashboard.home.title': 'Home',
  'shell.dashboard.legalEntity.accessBlocked': 'No legal entity is available for this account.',
  'shell.dashboard.legalEntity.accessibleLabel': 'Current legal entity',
  'shell.dashboard.legalEntity.failed': 'Legal entity switching failed',
  'shell.dashboard.legalEntity.pending': 'Switching legal entity',
  'shell.dashboard.legalEntity.tenantContext': 'Organization (no company)',
  'shell.dashboard.legalEntity.tenantContextActive': 'Organization scope is active',
  'shell.dashboard.legalEntity.unavailable': 'Legal entities unavailable',
  'shell.dashboard.navigation.home': 'Home',
  'shell.dashboard.navigation.label': 'Dashboard navigation',
  'shell.dashboard.sidebar.label': 'Dashboard sidebar',
  'shell.dashboard.tenant.accessibleLabel': 'Current tenant',
  'shell.dashboard.tenant.failed': 'Tenant switching failed',
  'shell.dashboard.tenant.pending': 'Switching tenant',
  'shell.dashboard.tenant.unavailable': 'Tenants unavailable',
  'shell.modules.discovery.timeout': 'Module deployment timed out',
  'shell.modules.state.active': 'Active',
  'shell.modules.state.readOnly': 'Read only',
  'shell.modules.unavailable': 'Module access unavailable',
  'shell.moduleTarget.reload_required': 'Reload this page to continue',
  'shell.search.archived': 'Archived',
  'shell.search.clear': 'Clear search',
  'shell.search.groups.counterparty': 'Customers and suppliers',
  'shell.search.groups.party': 'Contacts',
  'shell.search.label': 'Search',
  'shell.search.placeholder': 'Search customers and suppliers…',
  'shell.search.roles.CUSTOMER': 'Customer',
  'shell.search.suggestions.all': 'Show all results',
  'shell.search.suggestions.label': 'Search suggestions',
  'shell.search.suggestions.loading': 'Searching…',
};

const principalId = Schema.decodeUnknownSync(PrincipalIdSchema)('00000000-0000-4000-8000-000000000001');
const tenantId1 = Schema.decodeUnknownSync(TenantIdSchema)('00000000-0000-4000-8000-000000000101');
const tenantId2 = Schema.decodeUnknownSync(TenantIdSchema)('00000000-0000-4000-8000-000000000102');
const legalEntityId1 = Schema.decodeUnknownSync(LegalEntityIdSchema)('00000000-0000-4000-8000-000000000201');
const legalEntityId2 = Schema.decodeUnknownSync(LegalEntityIdSchema)('00000000-0000-4000-8000-000000000202');
const inventoryAppId = Schema.decodeUnknownSync(AppIdSchema)('inventory-app');
const navigationGroupKey = Schema.decodeUnknownSync(GroupKeySchema)('shell.navigation.modules');
const inventoryModuleId = Schema.decodeUnknownSync(ModuleIdSchema)('inventory.stock');
const compositionRevision = '1'.repeat(64);

const authenticatedModel = (options?: { readonly moduleEnabled?: boolean }): AuthenticatedHomePageModel => ({
  compositionRevision,
  contextState: 'authenticated',
  identity: {
    displayName: 'Ada Lovelace',
    email: 'ada@example.test',
    principalId,
    tenantId: tenantId1,
  },
  legalEntities: {
    items: [
      { legalEntityId: legalEntityId1, legalName: 'Alpha company' },
      { legalEntityId: legalEntityId2, legalName: 'Beta company' },
    ],
    state: 'available',
  },
  navigation: {
    deniedAppIds: [],
    items: [
      {
        appId: inventoryAppId,
        enabled: options?.moduleEnabled ?? true,
        entrypointKey: Schema.decodeUnknownSync(EntrypointKeySchema)('inventory.stock.page.records'),
        groupKey: navigationGroupKey,
        href: '/modules/inventory.stock',
        icon: 'icon-[mdi--warehouse]',
        label: { cs: 'Sklad', en: 'Inventory' },
        moduleId: inventoryModuleId,
        order: 10,
        state: 'read_only',
        unavailable: false,
        writable: false,
      },
    ],
    moduleIds: [inventoryModuleId],
    state: 'available',
    unavailableDeployments: [],
  },
  selectedLegalEntityId: legalEntityId1,
  state: 'authenticated',
  tenants: {
    items: [
      { name: 'Alpha tenant', tenantId: tenantId1 },
      { name: 'Zeta tenant', tenantId: tenantId2 },
    ],
    state: 'available',
  },
});

const emptyRouteComponent = () => null;

/**
 * The localised home route of a real router, loading whatever model the holder carries. Changing
 * the holder and calling `router.invalidate()` re-renders the page with the new loader data.
 */
const renderHome = (model: HomePageModel, language: ShellLanguage = 'en') =>
  Effect.gen(function* renderHomeRoute() {
    const holder = { current: model };
    // The dashboard's idle preload renders each route component of the menu and Home once in a detached root,
    // where it fails without route context. Under `act` React rethrows that expected failure, so Home renders from
    // the root route here and its own route keeps an empty component; it still reads the route's loader data.
    const router = makeShellRouter({
      page: { component: emptyRouteComponent, loaderData: () => holder.current, path: '/' },
      root: ShellHome,
      url: `/${language}/`,
    });
    // A full document reload leaves the page; the test records that it was asked for.
    const navigations = rstest.spyOn(router, 'navigate').mockResolvedValue(undefined);
    const runs = rstest.spyOn(browserRuntime, 'runPromise');
    const view = yield* renderShellRoute(router, shellTestCopy(language, copy));
    return { holder, navigations, router, runs, view };
  });

/** Every Effect the page has handed to the browser runtime, settled. */
const pageEffectsSettled = (runs: { readonly mock: { readonly results: readonly { readonly value: unknown }[] } }) =>
  Effect.promise(() => Promise.allSettled(runs.mock.results.map((result) => result.value)));

/** The Shell BFF that accepts tenant and company switches and sign-out, unless a test scripts otherwise. */
const switchingBff = (overrides: ShellBffScript = {}) =>
  makeShellBff({
    signOut: () => Effect.succeed(Schema.decodeUnknownSync(SignOutResponseSchema)({ signedOut: true })),
    switchLegalEntity: () =>
      Effect.succeed(
        Schema.decodeUnknownSync(SwitchLegalEntityResponseSchema)({ selectedLegalEntityId: legalEntityId2 }),
      ),
    switchTenant: () =>
      Effect.succeed(Schema.decodeUnknownSync(SwitchTenantResponseSchema)({ selectedTenantId: tenantId2 })),
    switchToTenantContext: () =>
      Effect.succeed(Schema.decodeUnknownSync(SwitchToTenantContextResponseSchema)({ selectedContext: 'tenant' })),
    ...overrides,
  });
const sent = (bff: ReturnType<typeof switchingBff>, endpoint: ShellBffEndpoint) =>
  bff.requests
    .filter((received) => received.endpoint === endpoint)
    .map(({ acceptLanguage, body }) => ({ acceptLanguage, body }));

afterEach(cleanup);

it.effect('anonymous home exposes only the localized login action', () =>
  Effect.gen(function* anonymousHome() {
    yield* renderHome({ state: 'anonymous' });
    expect(screen.getByRole('link', { name: 'Login' }).getAttribute('href')).toBe('/en/login');
    expect(screen.queryByRole('banner')).toBeNull();
  }),
);

it.effect('an anonymous dashboard goes straight to sign-in instead of a bare login button', () =>
  Effect.gen(function* anonymousGoesToSignIn() {
    const { navigations } = yield* renderHome({ state: 'anonymous' });
    expect(navigations).toHaveBeenCalledWith({ href: '/en/login', replace: true });
    expect(screen.getByRole('link', { name: 'Login' }).getAttribute('href')).toBe('/en/login');
  }),
);

it.effect('a dead session on the dashboard goes to Czech sign-in with the reason', () =>
  Effect.gen(function* deadSessionGoesToCzechSignIn() {
    const { navigations } = yield* renderHome({ reason: 'account_forbidden', state: 'anonymous' }, 'cs');
    expect(navigations).toHaveBeenCalledWith({ href: '/cs/login?reason=account_forbidden', replace: true });
    expect(screen.getByRole('link', { name: 'Login' }).getAttribute('href')).toBe('/cs/login');
  }),
);

it.effect('the unavailable dashboard exposes no navigable affordance', () =>
  Effect.gen(function* unavailableDashboard() {
    yield* renderHome({ state: 'unavailable' });
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  }),
);

it.effect('the reload-required dashboard exposes no navigable affordance', () =>
  Effect.gen(function* reloadRequiredDashboard() {
    yield* renderHome({ state: 'reload_required' });
    expect(screen.getByText('Reload this page to continue')).toBeTruthy();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  }),
);

it.effect('pins the server-rendered release during authenticated hydration', () =>
  Effect.gen(function* serverRenderedReleaseIsPinnedDuringHydration() {
    yield* renderHome(authenticatedModel());
    expect(yield* getDocumentCompositionRevision()).toBe(compositionRevision);
    expect(document.head.querySelectorAll('meta[name="ontos-composition-revision"]')).toHaveLength(1);
    expect(document.head.querySelector('meta[name="ontos-composition-revision"]')?.getAttribute('content')).toBe(
      compositionRevision,
    );
  }),
);

it.effect('keeps the hydrated document pinned when another release is rendered', () =>
  Effect.gen(function* hydrationKeepsTheOriginalRelease() {
    const model = authenticatedModel();
    const { holder, router } = yield* renderHome(model);
    holder.current = { ...model, compositionRevision: '2'.repeat(64) };
    yield* Effect.promise(() => router.invalidate());
    yield* Effect.promise(() => screen.findByText('Reload this page to continue'));
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(yield* getDocumentCompositionRevision()).toBe(compositionRevision);
  }),
);

it.effect('a disabled module affordance stays non-interactive text', () =>
  Effect.gen(function* disabledModule() {
    yield* renderHome(authenticatedModel({ moduleEnabled: false }));
    expect(screen.queryByRole('link', { name: 'Inventory' })).toBeNull();
    expect(screen.getAllByText('Inventory').length).toBeGreaterThan(0);
    expect(document.querySelector('a[href="/en/modules/inventory.stock"]')).toBeNull();
  }),
);

it.effect('authenticated home renders server-composed navigation and selected legal context', () =>
  Effect.gen(function* authenticatedHome() {
    yield* renderHome(authenticatedModel());
    expect(screen.getByRole('link', { name: 'Inventory' }).getAttribute('href')).toBe('/en/modules/inventory.stock');
    expect(screen.getByText('Read only')).toBeTruthy();
    expect(screen.getAllByText('Alpha company').length).toBeGreaterThan(0);
    expect(screen.queryByText(legalEntityId1)).toBeNull();
    expect(screen.queryByText(tenantId1)).toBeNull();
    expect(screen.queryByText('inventory.stock')).toBeNull();
  }),
);

it.live('successful tenant switch performs a full document reload', () => {
  const bff = switchingBff();
  return Effect.gen(function* successfulTenantSwitchPerformsAFull() {
    const user = userEvent.setup();
    const { navigations, runs } = yield* renderHome(authenticatedModel());
    yield* Effect.promise(() => user.click(screen.getByRole('combobox', { name: 'Current tenant' })));
    const tenantOption = yield* Effect.promise(() => screen.findByRole('option', { name: 'Zeta tenant' }));
    yield* Effect.promise(() => user.click(tenantOption));
    yield* pageEffectsSettled(runs);
    expect(sent(bff, 'switchTenant')).toEqual([{ acceptLanguage: 'en', body: { tenantId: tenantId2 } }]);
    expect(navigations).toHaveBeenCalledWith({ reloadDocument: true, to: '.' });
  }).pipe(Effect.provide(bff.browser));
});

it.live('successful legal-entity switch performs a full document reload', () => {
  const bff = switchingBff();
  return Effect.gen(function* successfulLegalEntitySwitchPerformsA() {
    const user = userEvent.setup();
    const { navigations, runs } = yield* renderHome(authenticatedModel());
    yield* Effect.promise(() => user.click(screen.getByRole('combobox', { name: 'Current legal entity' })));
    const legalEntityOption = yield* Effect.promise(() => screen.findByRole('option', { name: 'Beta company' }));
    yield* Effect.promise(() => user.click(legalEntityOption));
    yield* pageEffectsSettled(runs);
    expect(sent(bff, 'switchLegalEntity')).toEqual([{ acceptLanguage: 'en', body: { legalEntityId: legalEntityId2 } }]);
    expect(navigations).toHaveBeenCalledWith({ reloadDocument: true, to: '.' });
  }).pipe(Effect.provide(bff.browser));
});

it.live('top-bar search submits on Enter to the localized Shell search route', () =>
  Effect.gen(function* topBarSearchSubmitsOnEnter() {
    const user = userEvent.setup();
    const { navigations } = yield* renderHome(authenticatedModel());
    const header = screen.getByRole('banner', { name: 'Dashboard header' });
    const searchbox = within(header).getByRole('searchbox', { name: 'Search' });
    expect(searchbox.getAttribute('placeholder')).toBe('Search customers and suppliers…');
    expect(
      within(screen.getByRole('complementary', { name: 'Dashboard sidebar' })).queryByRole('searchbox'),
    ).toBeNull();
    yield* Effect.promise(() => user.type(searchbox, 'Unit 1{Enter}'));
    expect(navigations).toHaveBeenCalledWith({ to: '/en/search?q=Unit%201' });
  }),
);

const partyRef = {
  moduleId: 'party.registry',
  resourceId: '00000000-0000-4000-8000-000000000301',
  resourceType: 'party.registry.party',
  tenantId: tenantId1,
};
const counterpartyRef = {
  ...partyRef,
  resourceId: '00000000-0000-4000-8000-000000000302',
  resourceType: 'party.registry.counterparty',
};
const presentation = {
  business: {
    compositionRevision,
    entries: [
      {
        ownerModuleId: 'party.registry',
        presentation: {
          family: {
            icon: 'icon-[mdi--account-multiple-outline]',
            key: 'companies',
            label: { cs: 'Firmy', en: 'Customers and suppliers' },
            order: 10,
          },
          group: {
            icon: 'icon-[mdi--account-multiple-outline]',
            key: 'counterparty',
            label: { cs: 'Protiúčty', en: 'Customers and suppliers' },
            order: 10,
          },
          scope: 'company',
        },
        resourceType: 'party.registry.counterparty',
        searchKey: 'party.registry.search',
      },
      {
        ownerModuleId: 'party.registry',
        presentation: {
          family: {
            icon: 'icon-[mdi--account-multiple-outline]',
            key: 'people',
            label: { cs: 'Lidé', en: 'Contacts' },
            order: 20,
          },
          group: {
            icon: 'icon-[mdi--account-multiple-outline]',
            key: 'party',
            label: { cs: 'Strany', en: 'Contacts' },
            order: 20,
          },
          scope: 'company',
        },
        resourceType: 'party.registry.party',
        searchKey: 'party.registry.search.party',
      },
    ],
    schemaVersion: '1',
  },
  pages: [],
};
const searchAnswer = Schema.decodeUnknownSync(ShellSearchResponseSchema)({
  partial: false,
  presentation,
  results: [
    {
      currentRoles: ['CUSTOMER'],
      kind: 'counterparty',
      legalEntity: { legalEntityId: legalEntityId1, tenantId: tenantId1 },
      party: { archived: false, matchedViaAlias: false, ref: partyRef, title: 'Jana Dvořáková' },
      ref: counterpartyRef,
      title: 'Jana Dvořáková',
    },
    { archived: false, kind: 'party', matchedViaAlias: false, ref: partyRef, title: 'Jana Dvořáková' },
    {
      archived: true,
      kind: 'party',
      matchedViaAlias: false,
      ref: { ...partyRef, resourceId: '00000000-0000-4000-8000-000000000303' },
      title: 'Dvořák Stavby',
    },
  ],
});

it.live('top-bar typeahead shows grouped matches after a pause and moves between them by keyboard', () => {
  const bff = switchingBff({ search: () => Effect.succeed(searchAnswer) });
  return Effect.gen(function* topBarTypeahead() {
    const user = userEvent.setup();
    yield* renderHome(authenticatedModel());
    const searchbox = screen.getByRole('searchbox', { name: 'Search' });
    yield* Effect.promise(() => user.type(searchbox, 'dvor'));
    const customers = yield* Effect.promise(() => screen.findByRole('list', { name: 'Customers and suppliers' }));
    // One request for the whole burst of keystrokes, with the final text.
    expect(sent(bff, 'search').map(({ body }) => body)).toContainEqual({ compositionRevision, query: 'dvor' });
    const customer = within(customers).getByRole('link', { name: /Jana Dvořáková/u });
    expect(customer.getAttribute('aria-label')).toBe('Jana Dvořáková Customer');
    expect(customer.textContent).toContain('Customer');
    const contacts = screen.getByRole('list', { name: 'Contacts' });
    expect(
      within(contacts)
        .getAllByRole('link')
        .map(({ textContent }) => textContent),
    ).toEqual(['Dvořák StavbyArchived']);
    yield* Effect.promise(() => user.keyboard('{ArrowDown}'));
    expect(document.activeElement).toBe(customer);
    yield* Effect.promise(() => user.keyboard('{ArrowDown}{ArrowDown}'));
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search' }));
    yield* Effect.promise(() => user.keyboard('{Escape}'));
    expect(screen.queryByRole('list', { name: 'Contacts' })).toBeNull();
  }).pipe(Effect.provide(bff.browser));
});

it.live('"/" focuses the top-bar search outside text fields', () =>
  Effect.gen(function* slashFocusesTopBarSearch() {
    const user = userEvent.setup();
    yield* renderHome(authenticatedModel());
    yield* Effect.promise(() => user.keyboard('/'));
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search' }));
  }),
);

it.live('logout clears the authenticated composition together', () => {
  const bff = switchingBff();
  return Effect.gen(function* logoutClearsTheAuthenticatedCompositionTogether() {
    const user = userEvent.setup();
    const { navigations, runs } = yield* renderHome(authenticatedModel());
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Ada Lovelace' })));
    const logoutItem = yield* Effect.promise(() => screen.findByRole('menuitem', { name: 'Logout' }));
    // Happy DOM has no layout. Give pointer movement distinct coordinates so
    // the menu can distinguish it from virtual focus after a prior selection.
    yield* Effect.promise(() => user.pointer({ coords: { x: 10, y: 10 }, target: logoutItem }));
    yield* Effect.promise(() => user.click(logoutItem));
    yield* pageEffectsSettled(runs);
    // `toEqual` treats an absent body and an undefined one alike: sign-out sends none.
    expect(sent(bff, 'signOut')).toEqual([{ acceptLanguage: 'en' }]);
    expect(navigations).toHaveBeenCalledWith({ reloadDocument: true, to: '/en/login' });
  }).pipe(Effect.provide(bff.browser));
});

const tenantAuthenticationRequired = Schema.decodeUnknownSync(TenantAuthenticationRequiredProblemSchema)({
  _tag: 'TenantAuthenticationRequiredProblem',
  detail: 'The tenant session expired.',
  status: 401,
  title: 'Tenant authentication required',
  type: 'https://ontos.dev/problems/tenant-authentication-required',
});
const tenantAccessForbidden = Schema.decodeUnknownSync(TenantAccessForbiddenProblemSchema)({
  _tag: 'TenantAccessForbiddenProblem',
  detail: 'The principal cannot use this tenant.',
  status: 403,
  title: 'Tenant access forbidden',
  type: 'https://ontos.dev/problems/tenant-access-forbidden',
});
const legalEntityAccessForbidden = Schema.decodeUnknownSync(LegalEntityAccessForbiddenProblemSchema)({
  _tag: 'LegalEntityAccessForbiddenProblem',
  detail: 'The principal cannot use this legal entity.',
  status: 403,
  title: 'Legal entity access forbidden',
  type: 'https://ontos.dev/problems/legal-entity-access-forbidden',
});

interface SwitchFailureCase {
  readonly comboboxName: string;
  readonly endpoint: 'switchLegalEntity' | 'switchTenant';
  readonly failedText: string;
  readonly name: string;
  readonly optionName: string;
  readonly pendingText: string;
  readonly reloads: boolean;
  readonly script: ShellBffScript;
}

const switchFailureCases: SwitchFailureCase[] = [
  {
    comboboxName: 'Current tenant',
    endpoint: 'switchTenant',
    failedText: 'Tenant switching failed',
    name: 'a forbidden tenant switch',
    optionName: 'Zeta tenant',
    pendingText: 'Switching tenant',
    reloads: false,
    script: { switchTenant: () => Effect.fail(tenantAccessForbidden) },
  },
  {
    comboboxName: 'Current legal entity',
    endpoint: 'switchLegalEntity',
    failedText: 'Legal entity switching failed',
    name: 'a forbidden legal-entity switch',
    optionName: 'Beta company',
    pendingText: 'Switching legal entity',
    reloads: false,
    script: { switchLegalEntity: () => Effect.fail(legalEntityAccessForbidden) },
  },
  {
    comboboxName: 'Current tenant',
    endpoint: 'switchTenant',
    failedText: 'Tenant switching failed',
    name: 'an unauthenticated tenant switch',
    optionName: 'Zeta tenant',
    pendingText: 'Switching tenant',
    reloads: true,
    script: { switchTenant: () => Effect.fail(tenantAuthenticationRequired) },
  },
  {
    comboboxName: 'Current legal entity',
    endpoint: 'switchLegalEntity',
    failedText: 'Legal entity switching failed',
    name: 'an unauthenticated legal-entity switch',
    optionName: 'Beta company',
    pendingText: 'Switching legal entity',
    reloads: true,
    script: { switchLegalEntity: () => Effect.fail(tenantAuthenticationRequired) },
  },
];

it.live.each(switchFailureCases)(
  'settles $name into its own selector without leaving it pending',
  ({ comboboxName, endpoint, failedText, optionName, pendingText, reloads, script }) => {
    const bff = switchingBff(script);
    return Effect.gen(function* settlesTheSwitchFailureIntoItsOwnSelector() {
      const user = userEvent.setup();
      const { navigations, runs } = yield* renderHome(authenticatedModel());

      yield* Effect.promise(() => user.click(screen.getByRole('combobox', { name: comboboxName })));
      const option = yield* Effect.promise(() => screen.findByRole('option', { name: optionName }));
      yield* Effect.promise(() => user.click(option));
      yield* pageEffectsSettled(runs);
      expect(sent(bff, endpoint)).toHaveLength(1);

      if (reloads) {
        expect(navigations).toHaveBeenCalledWith({ reloadDocument: true, to: '.' });
        yield* Effect.promise(() => waitFor(() => expect(screen.queryByText(pendingText)).toBeNull()));
        expect(screen.queryByText(failedText)).toBeNull();
      } else {
        yield* Effect.promise(() => waitFor(() => expect(screen.getByText(failedText)).toBeTruthy()));
        expect(navigations).not.toHaveBeenCalled();
        expect(screen.queryByText(pendingText)).toBeNull();
      }

      expect(screen.getByRole('combobox', { name: comboboxName }).hasAttribute('disabled')).toBe(false);
    }).pipe(Effect.provide(bff.browser));
  },
);

it.effect('keeps an admitted company selectable with a clear empty state when no role grants an area', () =>
  Effect.gen(function* admittedCompanyWithoutAreas() {
    yield* renderHome({
      ...authenticatedModel(),
      homeContribution: { state: 'forbidden' },
      navigation: {
        deniedAppIds: [],
        items: [],
        moduleIds: [],
        state: 'available',
        unavailableDeployments: [],
      },
    });
    expect(screen.getByRole('combobox', { name: 'Current legal entity' }).textContent).toContain('Alpha company');
    expect(screen.getByText('You have not been assigned a role yet — ask your company administrator.')).toBeDefined();
    expect(screen.queryByText('No legal entity is available for this account.')).toBeNull();
  }),
);

it.live('does not load an owner Home component for forbidden or unavailable Home targets', () =>
  Effect.gen(function* noOwnerForClosedHome() {
    const fx = yield* makeFederationHost({
      answer: () => Effect.fail(new Error('No Home component may be requested')),
      refusedRemotes: [],
    });
    const { holder, router } = yield* renderHome({ ...authenticatedModel(), homeContribution: { state: 'forbidden' } });
    holder.current = { ...authenticatedModel(), homeContribution: { state: 'unavailable' } };
    yield* Effect.promise(() => router.invalidate());
    expect(fx.registered).toEqual([]);
    expect(fx.requests).toEqual([]);
  }),
);

const homeTargetFixture = (fields: {
  readonly appId: string;
  readonly componentKey: string;
  readonly entrypointKey: string;
  readonly expose: string;
  readonly manifestUrl: string;
  readonly moduleId: string;
  readonly remoteName: string;
  readonly writable: boolean;
}): ResolvedModuleTarget =>
  Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
    appId: fields.appId,
    componentKey: fields.componentKey,
    compositionRevision,
    entrypointKey: fields.entrypointKey,
    federation: {
      expose: fields.expose,
      manifest: { sha256: '3'.repeat(64), url: fields.manifestUrl },
      remoteName: fields.remoteName,
    },
    moduleId: fields.moduleId,
    routeParameters: {},
    writable: fields.writable,
  });

/** The owner's Home component: it shows the trusted context and the target the Shell handed it. */
const OwnerHome = ({ context, routeParams, target }: ModulePageProps & { readonly target: ResolvedModuleTarget }) => (
  <p>{`${target.componentKey}|${context?.displayName ?? 'no context'}|${context?.legalEntityId ?? 'no company'}|${Object.keys(routeParams).length}`}</p>
);

it.live.each([
  homeTargetFixture({
    appId: 'sales-insights',
    componentKey: 'demo.sales-insights.crm-dashboard',
    entrypointKey: 'demo.sales-insights.component.crm-dashboard',
    expose: './CrmDashboard',
    manifestUrl: 'https://sales.example.test/mf-manifest.json',
    moduleId: 'demo.sales-insights',
    remoteName: 'verticalSalesInsights',
    writable: true,
  }),
  homeTargetFixture({
    appId: 'inventory-app',
    componentKey: 'inventory.stock.home',
    entrypointKey: 'inventory.stock.component.home',
    expose: './Home',
    manifestUrl: 'https://inventory.example.test/mf-manifest.json',
    moduleId: 'inventory.stock',
    remoteName: 'verticalInventory',
    writable: false,
  }),
])('hands only the document-admitted Home target $componentKey and trusted context to its owner', (target) =>
  Effect.gen(function* admittedHomeTarget() {
    const fx = yield* makeFederationHost({ answer: () => Effect.succeed({ default: OwnerHome }), refusedRemotes: [] });
    yield* renderHome({ ...authenticatedModel(), homeContribution: { state: 'ready', target } });
    const rendered = yield* Effect.promise(() =>
      screen.findByText(`${target.componentKey}|Ada Lovelace|${legalEntityId1}|0`),
    );
    expect(rendered).toBeTruthy();
    // The admitted target is loaded as it is: no other remote, no other exposed module.
    expect(fx.registered).toEqual([{ entry: target.federation.manifest.url, name: target.federation.remoteName }]);
    expect(fx.requests).toEqual([`${target.federation.remoteName}/${target.federation.expose.slice(2)}`]);
  }),
);

const tenantScopeLegalEntities: AuthenticatedHomePageModel['legalEntities'] = {
  items: [
    { legalEntityId: legalEntityId1, legalName: 'Alpha company' },
    { legalEntityId: legalEntityId2, legalName: 'Beta company' },
  ],
  state: 'available',
  tenantContextAvailable: true,
};

it.live('offers explicit tenant scope only when admitted and reloads after selection', () => {
  const bff = switchingBff();
  return Effect.gen(function* selectTenantScope() {
    const model = authenticatedModel();
    const user = userEvent.setup();
    const { navigations, runs } = yield* renderHome({
      ...model,
      legalEntities: tenantScopeLegalEntities,
    });
    yield* Effect.promise(() => user.click(screen.getByRole('combobox', { name: 'Current legal entity' })));
    yield* Effect.promise(() => user.click(screen.getByRole('option', { name: 'Organization (no company)' })));
    yield* pageEffectsSettled(runs);
    expect(sent(bff, 'switchToTenantContext')).toEqual([{ acceptLanguage: 'en' }]);
    expect(sent(bff, 'switchLegalEntity')).toEqual([]);
    expect(navigations).toHaveBeenCalledWith({ reloadDocument: true, to: '.' });
  }).pipe(Effect.provide(bff.browser));
});

it.live('does not expose tenant scope from company access alone', () => {
  const bff = switchingBff();
  return Effect.gen(function* companyOnlyScope() {
    const user = userEvent.setup();
    yield* renderHome(authenticatedModel());
    yield* Effect.promise(() => user.click(screen.getByRole('combobox', { name: 'Current legal entity' })));
    expect(screen.queryByRole('option', { name: 'Organization (no company)' })).toBeNull();
    expect(sent(bff, 'switchToTenantContext')).toEqual([]);
  }).pipe(Effect.provide(bff.browser));
});

it.effect('renders persisted tenant scope without a selected company', () => {
  const bff = switchingBff();
  return Effect.gen(function* persistedTenantScope() {
    const { selectedLegalEntityId: _selected, ...tenantModel } = authenticatedModel();
    yield* renderHome({
      ...tenantModel,
      contextState: 'tenant_authenticated',
      legalEntities: tenantScopeLegalEntities,
    });
    expect(screen.getByRole('combobox', { name: 'Current legal entity' }).textContent).toContain(
      'Organization (no company)',
    );
    expect(screen.getByText('Organization scope is active')).toBeDefined();
    expect(sent(bff, 'switchToTenantContext')).toEqual([]);
  }).pipe(Effect.provide(bff.browser));
});
