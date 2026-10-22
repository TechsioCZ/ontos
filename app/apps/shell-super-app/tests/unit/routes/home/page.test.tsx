import { getDocumentCompositionRevision } from '@app/shared-contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect, Result, Schema } from 'effect';
import { afterEach, beforeEach, expect, rstest, it } from 'effect-rstest';

import {
  AppIdSchema,
  EntrypointKeySchema,
  GroupKeySchema,
  LegalEntityAccessForbiddenProblemSchema,
  LegalEntityIdSchema,
  ModuleIdSchema,
  PrincipalIdSchema,
  ResolvedModuleTargetSchema,
  TenantAccessForbiddenProblemSchema,
  TenantAuthenticationRequiredProblemSchema,
  TenantIdSchema,
} from '../../../../shared/api.ts';
import type { ModuleTargetPageModel } from '../../../../src/routes/[lang]/modules/[moduleId]/module-page-model.ts';
import type { HomePageModel } from '../../../../src/routes/[lang]/home-page-model.ts';
import { HomeView } from '../../../../src/routes/[lang]/page.tsx';
import { browserRuntime } from '../../../../src/runtime/browser-effect-runtime.ts' with {
  rstest: 'importActual',
};
import type { LocalizedLinkCall, LocalizedLinkDoubleProps } from '../../../support/localized-link-double.tsx';
import { renderLocalizedLinkDouble } from '../../../support/localized-link-double.tsx';
import { useSettledRouterState } from '../../../support/settled-router-state.ts';

const {
  browserRunPromiseMock,
  languageState,
  localizedLinkCalls,
  navigateMock,
  resolvedTargetMock,
  signOutMock,
  switchLegalEntityMock,
  switchTenantMock,
} = rstest.hoisted(() => {
  const recordedLinkCalls: LocalizedLinkCall[] = [];
  return {
    browserRunPromiseMock: rstest.fn(),
    languageState: { current: 'en' },
    localizedLinkCalls: recordedLinkCalls,
    navigateMock: rstest.fn(),
    resolvedTargetMock: rstest.fn<(props: { readonly model: ModuleTargetPageModel }) => null>(() => null),
    signOutMock: rstest.fn(),
    switchLegalEntityMock: rstest.fn(),
    switchTenantMock: rstest.fn(),
  };
});

rstest.mock('../../../../src/routes/[lang]/modules/[moduleId]/page.tsx', () => ({
  ResolvedTarget: resolvedTargetMock,
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
    'shell.modules.discovery.timeout': 'Module deployment timed out',
    'shell.modules.state.active': 'Active',
    'shell.modules.state.readOnly': 'Read only',
    'shell.modules.unavailable': 'Module access unavailable',
    'shell.moduleTarget.reload_required': 'Reload this page to continue',
    'shell.search.label': 'Search this legal entity',
    'shell.search.submit': 'Search',
  }),
);

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  Link: (props: LocalizedLinkDoubleProps) =>
    renderLocalizedLinkDouble(props, {
      calls: localizedLinkCalls,
      language: languageState,
    }),
  useLocalizedLocation: () => ({
    alternates: { cs: '/cs/', en: '/en/' },
    canonical: '/en/',
  }),
  useModernI18n: () => ({
    language: languageState.current,
    t: (key: string) => translations.get(key) ?? key,
  }),
}));

rstest.mock('@tanstack/react-router', () => ({
  useLoaderData: rstest.fn(),
  useNavigate: () => navigateMock,
  useRouter: () => ({ matchRoutes: () => [], preloadRoute: () => Promise.resolve(), routesById: {} }),

  // Read lazily: mock factories run before this module's imports are initialized.
  useRouterState: (options: Parameters<typeof useSettledRouterState>[0]) => useSettledRouterState(options),
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  signOut: signOutMock,
  switchLegalEntity: switchLegalEntityMock,
  switchTenant: switchTenantMock,
}));

rstest.mock('../../../../src/runtime/browser-effect-runtime.ts', () => ({
  browserRuntime: {
    runFork: browserRuntime.runFork,
    runPromise: browserRunPromiseMock,
    runSyncExit: browserRuntime.runSyncExit,
  },
}));

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

beforeEach(() => {
  navigateMock.mockResolvedValue(undefined);
  browserRunPromiseMock.mockImplementation(browserRuntime.runPromise);
  signOutMock.mockReturnValue(Effect.succeed({ signedOut: true }));
  switchTenantMock.mockReturnValue(Effect.succeed({ selectedTenantId: tenantId2 }));
  switchLegalEntityMock.mockReturnValue(Effect.succeed({ selectedLegalEntityId: legalEntityId2 }));
});

afterEach(() => {
  cleanup();
  languageState.current = 'en';
  localizedLinkCalls.length = 0;
  rstest.clearAllMocks();
});

it('anonymous home exposes only the localized login action', () => {
  render(<HomeView initialModel={{ state: 'anonymous' }} />);
  expect(screen.getByRole('link', { name: 'Login' }).getAttribute('href')).toBe('/en/login');
  expect(screen.queryByRole('banner')).toBeNull();
});

it('an anonymous dashboard goes straight to sign-in instead of a bare login button', () => {
  render(<HomeView initialModel={{ state: 'anonymous' }} />);
  expect(navigateMock).toHaveBeenCalledWith({ href: '/en/login', replace: true });
  expect(screen.getByRole('link', { name: 'Login' }).getAttribute('href')).toBe('/en/login');
});

it('a dead session on the dashboard goes to Czech sign-in with the reason', () => {
  languageState.current = 'cs';
  render(<HomeView initialModel={{ reason: 'account_forbidden', state: 'anonymous' }} />);
  expect(navigateMock).toHaveBeenCalledWith({ href: '/cs/login?reason=account_forbidden', replace: true });
  expect(screen.getByRole('link', { name: 'Login' }).getAttribute('href')).toBe('/cs/login');
});

it('the unavailable dashboard exposes no navigable affordance', () => {
  render(<HomeView initialModel={{ state: 'unavailable' }} />);
  expect(screen.queryAllByRole('link')).toHaveLength(0);
  expect(localizedLinkCalls).toHaveLength(0);
});

it('the reload-required dashboard exposes no navigable affordance', () => {
  render(<HomeView initialModel={{ state: 'reload_required' }} />);
  expect(screen.getByText('Reload this page to continue')).toBeTruthy();
  expect(screen.queryAllByRole('link')).toHaveLength(0);
});

it.effect('pins the server-rendered release during authenticated hydration', () =>
  Effect.gen(function* serverRenderedReleaseIsPinnedDuringHydration() {
    render(<HomeView initialModel={authenticatedModel()} />);
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
    const { rerender } = render(<HomeView initialModel={model} />);
    rerender(<HomeView initialModel={{ ...model, compositionRevision: '2'.repeat(64) }} />);
    expect(screen.getByText('Reload this page to continue')).toBeTruthy();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(yield* getDocumentCompositionRevision()).toBe(compositionRevision);
  }),
);

it('a disabled module affordance stays non-interactive text', () => {
  render(<HomeView initialModel={authenticatedModel({ moduleEnabled: false })} />);
  expect(screen.queryByRole('link', { name: 'Inventory' })).toBeNull();
  expect(screen.getByText('Inventory')).toBeTruthy();
  expect(localizedLinkCalls.map((call) => call.to)).not.toContain('/modules/inventory.stock');
});

it('authenticated home renders server-composed navigation and selected legal context', () => {
  render(<HomeView initialModel={authenticatedModel()} />);
  expect(screen.getByRole('link', { name: 'Inventory' }).getAttribute('href')).toBe('/en/modules/inventory.stock');
  expect(screen.getByText('Read only')).toBeTruthy();
  expect(screen.getAllByText('Alpha company').length).toBeGreaterThan(0);
  expect(screen.queryByText(legalEntityId1)).toBeNull();
  expect(screen.queryByText(tenantId1)).toBeNull();
  expect(screen.queryByText('inventory.stock')).toBeNull();
});

it.live('successful tenant switch performs a full document reload', () =>
  Effect.gen(function* successfulTenantSwitchPerformsAFull() {
    const user = userEvent.setup();
    render(<HomeView initialModel={authenticatedModel()} />);
    yield* Effect.promise(() => user.click(screen.getByRole('combobox', { name: 'Current tenant' })));
    const tenantOption = yield* Effect.promise(() => screen.findByRole('option', { name: 'Zeta tenant' }));
    yield* Effect.promise(() => user.click(tenantOption));
    yield* Effect.promise(() =>
      waitFor(() => expect(switchTenantMock).toHaveBeenCalledWith({ tenantId: tenantId2 }, { locale: 'en' })),
    );
    yield* Effect.promise(() =>
      waitFor(() =>
        expect(navigateMock).toHaveBeenCalledWith({
          reloadDocument: true,
          to: '.',
        }),
      ),
    );
  }),
);

it.live('successful legal-entity switch performs a full document reload', () =>
  Effect.gen(function* successfulLegalEntitySwitchPerformsA() {
    const user = userEvent.setup();
    render(<HomeView initialModel={authenticatedModel()} />);
    yield* Effect.promise(() => user.click(screen.getByRole('combobox', { name: 'Current legal entity' })));
    const legalEntityOption = yield* Effect.promise(() => screen.findByRole('option', { name: 'Beta company' }));
    yield* Effect.promise(() => user.click(legalEntityOption));
    yield* Effect.promise(() =>
      waitFor(() =>
        expect(switchLegalEntityMock).toHaveBeenCalledWith({ legalEntityId: legalEntityId2 }, { locale: 'en' }),
      ),
    );
    yield* Effect.promise(() =>
      waitFor(() =>
        expect(navigateMock).toHaveBeenCalledWith({
          reloadDocument: true,
          to: '.',
        }),
      ),
    );
  }),
);

it.live('the header offers no global search: search lives in each governed agenda', () =>
  Effect.gen(function* headerOffersNoGlobalSearch() {
    render(<HomeView initialModel={authenticatedModel()} />);
    expect(screen.queryByLabelText('Search this legal entity')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
    yield* Effect.void;
  }),
);

it.live('logout clears the authenticated composition together', () =>
  Effect.gen(function* logoutClearsTheAuthenticatedCompositionTogether() {
    const user = userEvent.setup();
    render(<HomeView initialModel={authenticatedModel()} />);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Ada Lovelace' })));
    const logoutItem = yield* Effect.promise(() => screen.findByRole('menuitem', { name: 'Logout' }));
    // Happy DOM has no layout. Give pointer movement distinct coordinates so
    // the menu can distinguish it from virtual focus after a prior selection.
    yield* Effect.promise(() => user.pointer({ coords: { x: 10, y: 10 }, target: logoutItem }));
    yield* Effect.promise(() => user.click(logoutItem));
    yield* Effect.promise(() => waitFor(() => expect(signOutMock).toHaveBeenCalledWith({ locale: 'en' })));
    yield* Effect.promise(() =>
      waitFor(() =>
        expect(navigateMock).toHaveBeenCalledWith({
          reloadDocument: true,
          to: '/en/login',
        }),
      ),
    );
  }),
);

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
  readonly failedText: string;
  readonly failure:
    | typeof legalEntityAccessForbidden
    | typeof tenantAccessForbidden
    | typeof tenantAuthenticationRequired;
  readonly name: string;
  readonly optionName: string;
  readonly pendingText: string;
  readonly reloads: boolean;
  readonly switchMock: typeof switchLegalEntityMock;
}

const switchFailureCases: SwitchFailureCase[] = [
  {
    comboboxName: 'Current tenant',
    failedText: 'Tenant switching failed',
    failure: tenantAccessForbidden,
    name: 'a forbidden tenant switch',
    optionName: 'Zeta tenant',
    pendingText: 'Switching tenant',
    reloads: false,
    switchMock: switchTenantMock,
  },
  {
    comboboxName: 'Current legal entity',
    failedText: 'Legal entity switching failed',
    failure: legalEntityAccessForbidden,
    name: 'a forbidden legal-entity switch',
    optionName: 'Beta company',
    pendingText: 'Switching legal entity',
    reloads: false,
    switchMock: switchLegalEntityMock,
  },
  {
    comboboxName: 'Current tenant',
    failedText: 'Tenant switching failed',
    failure: tenantAuthenticationRequired,
    name: 'an unauthenticated tenant switch',
    optionName: 'Zeta tenant',
    pendingText: 'Switching tenant',
    reloads: true,
    switchMock: switchTenantMock,
  },
  {
    comboboxName: 'Current legal entity',
    failedText: 'Legal entity switching failed',
    failure: tenantAuthenticationRequired,
    name: 'an unauthenticated legal-entity switch',
    optionName: 'Beta company',
    pendingText: 'Switching legal entity',
    reloads: true,
    switchMock: switchLegalEntityMock,
  },
];

it.live.each(switchFailureCases)(
  'settles $name into its own selector without leaving it pending',
  ({ comboboxName, failedText, failure, optionName, pendingText, reloads, switchMock }) =>
    Effect.gen(function* settlesTheSwitchFailureIntoItsOwnSelector() {
      switchMock.mockReturnValue(Effect.fail(failure));
      const user = userEvent.setup();
      render(<HomeView initialModel={authenticatedModel()} />);

      yield* Effect.promise(() => user.click(screen.getByRole('combobox', { name: comboboxName })));
      const option = yield* Effect.promise(() => screen.findByRole('option', { name: optionName }));
      yield* Effect.promise(() => user.click(option));
      yield* Effect.promise(() => waitFor(() => expect(switchMock).toHaveBeenCalledTimes(1)));

      if (reloads) {
        yield* Effect.promise(() =>
          waitFor(() =>
            expect(navigateMock).toHaveBeenCalledWith({
              reloadDocument: true,
              to: '.',
            }),
          ),
        );
        yield* Effect.promise(() => waitFor(() => expect(screen.queryByText(pendingText)).toBeNull()));
        expect(screen.queryByText(failedText)).toBeNull();
      } else {
        yield* Effect.promise(() => waitFor(() => expect(screen.getByText(failedText)).toBeTruthy()));
        expect(navigateMock).not.toHaveBeenCalled();
        expect(screen.queryByText(pendingText)).toBeNull();
      }

      expect(screen.getByRole('combobox', { name: comboboxName }).hasAttribute('disabled')).toBe(false);
    }),
);

it('does not invoke the lazy owner renderer for forbidden or unavailable Home targets', () => {
  const model = authenticatedModel();
  if (model.state !== 'authenticated') {
    throw new Error('Expected authenticated fixture');
  }
  const { rerender } = render(<HomeView initialModel={{ ...model, homeContribution: { state: 'forbidden' } }} />);
  expect(resolvedTargetMock).not.toHaveBeenCalled();
  rerender(<HomeView initialModel={{ ...model, homeContribution: { state: 'unavailable' } }} />);
  expect(resolvedTargetMock).not.toHaveBeenCalled();
});

it('hands only the admitted Home target and trusted context to the existing lazy owner renderer', () => {
  const model = authenticatedModel();
  if (model.state !== 'authenticated') {
    throw new Error('Expected authenticated fixture');
  }
  const target = Result.getOrThrow(
    Schema.decodeResult(ResolvedModuleTargetSchema)({
      appId: 'sales-insights',
      componentKey: 'demo.sales-insights.crm-dashboard',
      compositionRevision,
      entrypointKey: 'demo.sales-insights.component.crm-dashboard',
      federation: {
        expose: './CrmDashboard',
        manifest: { sha256: '3'.repeat(64), url: 'https://sales.example.test/mf-manifest.json' },
        remoteName: 'verticalSalesInsights',
      },
      moduleId: 'demo.sales-insights',
      routeParameters: {},
      writable: true,
    }),
  );
  render(<HomeView initialModel={{ ...model, homeContribution: { state: 'ready', target } }} />);
  expect(resolvedTargetMock).toHaveBeenCalled();
  expect(resolvedTargetMock.mock.calls[0]?.[0]).toMatchObject({
    model: {
      shell: { identity: model.identity, selectedLegalEntityId: model.selectedLegalEntityId },
      state: 'resolved',
      target,
    },
  });
});
