import { getDocumentCompositionRevision } from '@app/shared-contracts';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect, Schema } from 'effect';
import { afterEach, expect, it, rstest } from 'effect-rstest';

import {
  AppIdSchema,
  GroupKeySchema,
  LegalEntityAccessForbiddenProblemSchema,
  LegalEntityIdSchema,
  ModuleIdSchema,
  PrincipalIdSchema,
  SignOutResponseSchema,
  SwitchLegalEntityResponseSchema,
  SwitchTenantResponseSchema,
  TenantAccessForbiddenProblemSchema,
  TenantAuthenticationRequiredProblemSchema,
  TenantIdSchema,
} from '../../../../shared/browser-api.ts';
import type { HomePageModel } from '../../../../src/routes/[lang]/home-page-model.ts';
import ShellHome from '../../../../src/routes/[lang]/page.tsx';
import { browserRuntime } from '../../../../src/runtime/browser-effect-runtime.ts';
import { makeShellBff } from '../../../support/shell-bff-double.ts';
import type { ShellBffEndpoint, ShellBffScript } from '../../../support/shell-bff-double.ts';
import { shellTestCopy } from '../../../support/shell-i18n.tsx';
import type { ShellLanguage } from '../../../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../../../support/shell-router.tsx';

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
  'shell.modules.discovery.timeout': 'Module deployment timed out',
  'shell.modules.state.active': 'Active',
  'shell.modules.state.readOnly': 'Read only',
  'shell.modules.unavailable': 'Module access unavailable',
  'shell.moduleTarget.reload_required': 'Reload this page to continue',
  'shell.search.label': 'Search this legal entity',
  'shell.search.submit': 'Search',
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

const authenticatedModel = (options?: { readonly moduleEnabled?: boolean }): HomePageModel => ({
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
    items: [
      {
        appId: inventoryAppId,
        enabled: options?.moduleEnabled ?? true,
        groupKey: navigationGroupKey,
        href: '/modules/inventory.stock',
        label: 'Inventory',
        moduleId: inventoryModuleId,
        order: 10,
        state: 'read_only',
        unavailable: false,
        writable: false,
      },
    ],
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

/**
 * The localised home route of a real router, loading whatever model the holder carries. Changing
 * the holder and calling `router.invalidate()` re-renders the page with the new loader data.
 */
const renderHome = (model: HomePageModel, language: ShellLanguage = 'en') =>
  Effect.gen(function* renderHomeRoute() {
    const holder = { current: model };
    const router = makeShellRouter({
      page: { component: ShellHome, loaderData: () => holder.current, path: '/' },
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

it.effect('the anonymous login action resolves Czech from the same canonical target', () =>
  Effect.gen(function* czechLogin() {
    yield* renderHome({ state: 'anonymous' }, 'cs');
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
    if (model.state !== 'authenticated') {
      throw new Error('Expected the authenticated dashboard fixture.');
    }
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
    expect(screen.getByText('Inventory')).toBeTruthy();
    expect(document.querySelector('a[href="/en/modules/inventory.stock"]')).toBeNull();
  }),
);

it.effect('authenticated home renders server-composed navigation and selected legal context', () =>
  Effect.gen(function* authenticatedHome() {
    yield* renderHome(authenticatedModel());
    expect(screen.getByRole('link', { name: 'Inventory' }).getAttribute('href')).toBe('/en/modules/inventory.stock');
    expect(screen.getByText('Read only')).toBeTruthy();
    expect(screen.getByText(legalEntityId1)).toBeTruthy();
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
    expect(navigations).toHaveBeenCalledWith(expect.objectContaining({ reloadDocument: true, to: '.' }));
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
    expect(navigations).toHaveBeenCalledWith(expect.objectContaining({ reloadDocument: true, to: '.' }));
  }).pipe(Effect.provide(bff.browser));
});

it.live('search submission navigates to the localized Shell search route', () =>
  Effect.gen(function* searchSubmissionNavigatesToTheLocalized() {
    const user = userEvent.setup();
    const { navigations } = yield* renderHome(authenticatedModel());
    yield* Effect.promise(() => user.type(screen.getByLabelText('Search this legal entity'), 'Unit 1'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Search' })));
    expect(navigations).toHaveBeenCalledWith(expect.objectContaining({ to: '/en/search?q=Unit%201' }));
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
    expect(navigations).toHaveBeenCalledWith(expect.objectContaining({ reloadDocument: true, to: '/en/login' }));
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
        expect(navigations).toHaveBeenCalledWith(expect.objectContaining({ reloadDocument: true, to: '.' }));
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
