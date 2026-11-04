import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, rstest, test } from 'effect-rstest';

import {
  AppIdSchema,
  EntrypointKeySchema,
  GroupKeySchema,
  LegalEntityIdSchema,
  ModuleIdSchema,
  PrincipalIdSchema,
  ResourceIdSchema,
  TenantIdSchema,
} from '../../../../shared/api.ts';
import type { ShellNavigationItem, ShellSearchResult } from '../../../../shared/api.ts';
import type { HomePageModel } from '../../../../src/routes/[lang]/home-page-model.ts';
import type { SearchFilterPlan, SearchPageModel } from '../../../../src/routes/[lang]/search/search-page-model.ts';
import SearchPage from '../../../../src/routes/[lang]/search/page.tsx';
import { browserRuntime } from '../../../../src/runtime/browser-effect-runtime.ts' with {
  rstest: 'importActual',
};
import type { LocalizedLinkCall, LocalizedLinkDoubleProps } from '../../../support/localized-link-double.tsx';
import { renderLocalizedLinkDouble } from '../../../support/localized-link-double.tsx';

interface RouterLocationDouble {
  readonly href: string;
  readonly pathname: string;
  readonly search: Readonly<Record<string, string>>;
}

interface RouterStateDouble {
  readonly location: RouterLocationDouble;
  readonly resolvedLocation: RouterLocationDouble;
}

/** The router's parsed search for a URL, as TanStack hands it to `useRouterState`. */
const searchOf = (href: string): Readonly<Record<string, string>> => {
  const query = new URL(href, 'http://localhost').searchParams.get('q');
  return query === null ? {} : { q: query };
};

const routerLocation = (href: string, pathname = '/en/search'): RouterLocationDouble => ({
  href,
  pathname,
  search: searchOf(href),
});

const settledRouterState = (href: string, pathname = '/en/search'): RouterStateDouble => ({
  location: routerLocation(href, pathname),
  resolvedLocation: routerLocation(href, pathname),
});

const pendingRouterState = (href: string, resolvedHref: string): RouterStateDouble => ({
  location: routerLocation(href),
  resolvedLocation: routerLocation(resolvedHref),
});

const {
  browserRunPromiseMock,
  languageState,
  localizedLinkCalls,
  localizedLinkMock,
  navigateMock,
  routerState,
  signOutMock,
  switchLegalEntityMock,
  switchTenantMock,
  useLoaderDataMock,
} = rstest.hoisted(() => {
  const recordedLinkCalls: LocalizedLinkCall[] = [];
  return {
    browserRunPromiseMock: rstest.fn(),
    languageState: { current: 'en' },
    localizedLinkCalls: recordedLinkCalls,
    localizedLinkMock: rstest.fn<(props: LocalizedLinkDoubleProps) => void>(),
    navigateMock: rstest.fn(async () => {}),
    // Mutable on purpose: one test can hold a navigation whose loader has not answered yet.
    routerState: {
      current: {
        location: { href: '/en/search', pathname: '/en/search', search: {} },
        resolvedLocation: { href: '/en/search', pathname: '/en/search', search: {} },
      },
    },
    signOutMock: rstest.fn(),
    switchLegalEntityMock: rstest.fn(),
    switchTenantMock: rstest.fn(),
    useLoaderDataMock: rstest.fn(),
  };
});

const translations = new Map(
  Object.entries({
    'shell.auth.identity.title': 'Authenticated identity',
    'shell.auth.logout.action': 'Logout',
    'shell.auth.logout.failed': 'Logout failed',
    'shell.dashboard.account.label': 'Account menu',
    'shell.dashboard.brand': 'OntOS',
    'shell.dashboard.header.label': 'Dashboard header',
    'shell.dashboard.legalEntity.accessibleLabel': 'Current legal entity',
    'shell.dashboard.navigation.home': 'Home',
    'shell.dashboard.navigation.label': 'Dashboard navigation',
    'shell.dashboard.sidebar.label': 'Dashboard sidebar',
    'shell.dashboard.tenant.accessibleLabel': 'Current tenant',
    'shell.dashboard.unavailable': 'Dashboard unavailable',
    'shell.modules.state.readOnly': 'Read only',
    'shell.moduleTarget.reload_required': 'Reload this page to continue',
    'shell.search.agenda_hint': 'Open an authorized agenda and use its search.',
    'shell.search.agenda_title': 'Search within an agenda',
    'shell.search.alias_match': 'Alias match',
    'shell.search.archived': 'Archived',
    'shell.search.empty': 'No authorized results found.',
    'shell.search.groups.counterparty': 'Customers and suppliers',
    'shell.search.groups.invoice': 'Invoices',
    'shell.search.groups.resource': 'Other records',
    'shell.search.groups.task': 'Tasks',
    'shell.search.label': 'Search',
    'shell.search.legal_entity': 'Legal Entity',
    'shell.search.partial': 'Some search providers are temporarily unavailable.',
    'shell.search.placeholder': 'Search clients, tasks, invoices, contracts…',
    'shell.search.reconciliation_required': 'Reconciliation required',
    'shell.search.roles.CUSTOMER': 'Customer',
    'shell.search.roles.SUPPLIER': 'Supplier',
    'shell.search.selection_required': 'Select a legal entity first',
    'shell.search.suggestions.empty': 'Nothing found for “{{query}}”.',
    'shell.search.suggestions.label': 'Search suggestions',
    'shell.search.suggestions.loading': 'Searching…',
    'shell.search.title': 'Search',
    'shell.search.unavailable': 'Search unavailable',
  }),
);

/** The i18n double keeps the locale files' interpolation contract instead of concatenating sentences. */
const translate = (key: string, values?: Readonly<Record<string, string>>): string => {
  let sentence = translations.get(key) ?? key;
  for (const [name, value] of Object.entries(values ?? {})) {
    sentence = sentence.replaceAll(`{{${name}}}`, value);
  }
  return sentence;
};

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  Link: (props: LocalizedLinkDoubleProps) => {
    localizedLinkMock(props);
    return renderLocalizedLinkDouble(props, {
      calls: localizedLinkCalls,
      language: languageState,
    });
  },
  useLocalizedLocation: () => ({
    alternates: { cs: '/cs/hledat', en: '/en/search' },
  }),
  useModernI18n: () => ({
    language: languageState.current,
    t: translate,
  }),
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useLoaderData: useLoaderDataMock,
  useNavigate: () => navigateMock,
  useRouter: () => ({ matchRoutes: () => [], preloadRoute: () => Promise.resolve(), routesById: {} }),

  // Read lazily: mock factories run before this module's imports are initialized.
  useRouterState: (options: { readonly select: (state: RouterStateDouble) => boolean | string | undefined }) =>
    options.select(routerState.current),
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
    runSync: browserRuntime.runSync,
    runSyncExit: browserRuntime.runSyncExit,
  },
}));

const principalId = Schema.decodeUnknownSync(PrincipalIdSchema)('00000000-0000-4000-8000-000000000001');
const tenantId = Schema.decodeUnknownSync(TenantIdSchema)('00000000-0000-4000-8000-000000000101');
const legalEntityId = Schema.decodeUnknownSync(LegalEntityIdSchema)('00000000-0000-4000-8000-000000000201');
const inventoryAppId = Schema.decodeUnknownSync(AppIdSchema)('inventory-app');
const navigationGroupKey = Schema.decodeUnknownSync(GroupKeySchema)('shell.navigation.modules');
const inventoryModuleId = Schema.decodeUnknownSync(ModuleIdSchema)('inventory.stock');
const plainResourceId = Schema.decodeUnknownSync(ResourceIdSchema)('unit-1');
const awkwardResourceId = Schema.decodeUnknownSync(ResourceIdSchema)('unit #1/2');
const financeGroupKey = Schema.decodeUnknownSync(GroupKeySchema)('shell.navigation.finance');
const salesGroupKey = Schema.decodeUnknownSync(GroupKeySchema)('shell.navigation.sales');
const teamGroupKey = Schema.decodeUnknownSync(GroupKeySchema)('shell.navigation.team');

/** One destination of the composed navigation: the page a record type of this document opens. */
const navigationItem = (moduleId: string, groupKey: typeof navigationGroupKey, href: string): ShellNavigationItem => ({
  appId: Schema.decodeUnknownSync(AppIdSchema)(`${moduleId}-app`),
  enabled: true,
  entrypointKey: Schema.decodeUnknownSync(EntrypointKeySchema)(`${moduleId}.page.records`),
  groupKey,
  href,
  icon: 'icon-[mdi--file-outline]',
  label: { cs: href, en: href },
  moduleId: Schema.decodeUnknownSync(ModuleIdSchema)(moduleId),
  order: 20,
  state: 'active' as const,
  unavailable: false,
  writable: true,
});

const authenticatedShell = (): HomePageModel => ({
  compositionRevision: '1'.repeat(64),
  contextState: 'authenticated',
  identity: {
    displayName: 'Ada Lovelace',
    email: 'ada@example.test',
    principalId,
    tenantId,
  },
  legalEntities: {
    items: [{ legalEntityId, legalName: 'Alpha company' }],
    state: 'available',
  },
  navigation: {
    deniedAppIds: [],
    items: [
      {
        appId: inventoryAppId,
        enabled: true,
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
      navigationItem('finance.billing', financeGroupKey, '/finance'),
      navigationItem('party.registry', salesGroupKey, '/prodej/zakaznici'),
      navigationItem('work.tasks', teamGroupKey, '/ukoly'),
    ],
    moduleIds: [
      inventoryModuleId,
      Schema.decodeUnknownSync(ModuleIdSchema)('finance.billing'),
      Schema.decodeUnknownSync(ModuleIdSchema)('party.registry'),
      Schema.decodeUnknownSync(ModuleIdSchema)('work.tasks'),
    ],
    recordDestinations: [],
    state: 'available',
    unavailableDeployments: [],
  },
  selectedLegalEntityId: legalEntityId,
  state: 'authenticated',
  tenants: {
    items: [{ name: 'Alpha tenant', tenantId }],
    state: 'available',
  },
});

/** A generic owner hit as the Shell receives it, scoped to the trusted selected company. */
const resourceHit = (
  moduleId: string,
  resourceType: string,
  resourceId: typeof plainResourceId,
  title: string,
): ShellSearchResult => ({
  kind: 'resource',
  ref: { moduleId: Schema.decodeUnknownSync(ModuleIdSchema)(moduleId), resourceId, resourceType, tenantId },
  selectedLegalEntityId: legalEntityId,
  title,
});

const emptyFilters: SearchFilterPlan = { availableFamilies: [], selectedFamilies: [] };

const readyModel = (resourceType: string, resourceId: typeof plainResourceId): SearchPageModel => ({
  filters: emptyFilters,
  query: 'unit',
  response: {
    partial: false,
    results: [resourceHit('inventory.stock', resourceType, resourceId, 'Unit 1')],
  },
  shell: authenticatedShell(),
  state: 'ready',
});

/** A company relationship hit with the Party fields the shared row may show, and nothing else. */
const counterpartyHit = ({
  alias = false,
  archived = false,
  collision = false,
  roles,
}: {
  readonly alias?: boolean;
  readonly archived?: boolean;
  readonly collision?: boolean;
  readonly roles: readonly ('CUSTOMER' | 'SUPPLIER')[];
}): ShellSearchResult => {
  const partyId = Schema.decodeUnknownSync(ResourceIdSchema)('00000000-0000-4000-8000-000000000501');
  const counterpartyId = Schema.decodeUnknownSync(ResourceIdSchema)('00000000-0000-4000-8000-000000000502');
  const hit: Extract<ShellSearchResult, { readonly kind: 'counterparty' }> = {
    currentRoles: [...roles],
    kind: 'counterparty',
    legalEntity: { legalEntityId, tenantId },
    party: {
      archived,
      matchedViaAlias: alias,
      ref: {
        moduleId: Schema.decodeUnknownSync(ModuleIdSchema)('party.registry'),
        resourceId: partyId,
        resourceType: 'party.registry.party',
        tenantId,
      },
      title: 'Acme',
    },
    ref: {
      moduleId: Schema.decodeUnknownSync(ModuleIdSchema)('party.registry'),
      resourceId: counterpartyId,
      resourceType: 'party.registry.counterparty',
      tenantId,
    },
    title: 'Acme s.r.o.',
  };
  if (!collision) {
    return hit;
  }
  return {
    ...hit,
    collision: {
      counterpartyRefs: [
        {
          moduleId: Schema.decodeUnknownSync(ModuleIdSchema)('party.registry'),
          resourceId: counterpartyId,
          resourceType: 'party.registry.counterparty',
          tenantId,
        },
      ],
      kind: 'CANONICAL_PARTY_COUNTERPARTY_COLLISION',
    },
  };
};

const resourceLinkCalls = () => localizedLinkCalls.filter((call) => call.to.startsWith('/resources'));

/** Rows the page rendered, in document order. */
const renderedRows = () => [...document.querySelectorAll('[data-shell-search-result]')];

beforeEach(() => {
  browserRunPromiseMock.mockImplementation(browserRuntime.runPromise);
  signOutMock.mockReturnValue(Effect.succeed({ signedOut: true }));
  switchTenantMock.mockReturnValue(Effect.succeed({ selectedTenantId: tenantId }));
  switchLegalEntityMock.mockReturnValue(Effect.succeed({ selectedLegalEntityId: legalEntityId }));
  useLoaderDataMock.mockReturnValue(readyModel('stock-item', plainResourceId));
  routerState.current = settledRouterState('/en/search?q=unit');
});

afterEach(() => {
  cleanup();
  languageState.current = 'en';
  localizedLinkCalls.length = 0;
  routerState.current = settledRouterState('/en/search');
  rstest.clearAllMocks();
});

test('a search result hands the canonical resource route to the framework link', () => {
  render(<SearchPage />);

  const resultCalls = localizedLinkMock.mock.calls
    .map(([props]) => props)
    .filter(({ to }) => to.startsWith('/resources'));
  expect(resultCalls.length).toBeGreaterThan(0);
  for (const resultCall of resultCalls) {
    expect(resultCall.to).toBe('/resources/$moduleId/$resourceType/$resourceId');
    expect(resultCall.params).toEqual({
      moduleId: 'inventory.stock',
      resourceId: 'unit-1',
      resourceType: 'stock-item',
    });
    expect(resultCall.href).toBeUndefined();
  }
  expect(screen.getByRole('link', { name: /Unit 1/u }).getAttribute('href')).toBe(
    '/en/resources/inventory.stock/stock-item/unit-1',
  );
});

test('a search result resolves the Czech resource route from the same canonical target', () => {
  languageState.current = 'cs';
  render(<SearchPage />);

  expect(resourceLinkCalls()[0]?.to).toBe('/resources/$moduleId/$resourceType/$resourceId');
  expect(screen.getByRole('link', { name: /Unit 1/u }).getAttribute('href')).toBe(
    '/cs/zdroje/inventory.stock/stock-item/unit-1',
  );
});

test('resource path segments stay percent-encoded per segment', () => {
  useLoaderDataMock.mockReturnValue(readyModel('stock item', awkwardResourceId));
  render(<SearchPage />);

  expect(resourceLinkCalls()[0]?.params).toEqual({
    moduleId: 'inventory.stock',
    resourceId: 'unit #1/2',
    resourceType: 'stock item',
  });
  expect(screen.getByRole('link', { name: /Unit 1/u }).getAttribute('href')).toBe(
    '/en/resources/inventory.stock/stock%20item/unit%20%231%2F2',
  );
});

test('results keep the server-wide order across families and name each type', () => {
  const invoiceId = Schema.decodeUnknownSync(ResourceIdSchema)('00000000-0000-4000-8000-000000000401');
  const taskId = Schema.decodeUnknownSync(ResourceIdSchema)('00000000-0000-4000-8000-000000000402');
  useLoaderDataMock.mockReturnValue({
    filters: emptyFilters,
    query: 'novák',
    response: {
      partial: false,
      results: [
        resourceHit('inventory.stock', 'stock-item', plainResourceId, 'Novák sklad'),
        resourceHit('finance.billing', 'finance.billing.invoice', invoiceId, 'Faktura Novák'),
        resourceHit('work.tasks', 'work.tasks.task', taskId, 'Zavolat Novákovi'),
      ],
    },
    shell: authenticatedShell(),
    state: 'ready',
  } satisfies SearchPageModel);
  render(<SearchPage />);

  const linkProps = localizedLinkMock.mock.calls.map(([props]) => props);
  // The sidebar also links these destinations; the result row is the call carrying the record it opens.
  expect(linkProps.findLast(({ to }) => to === '/finance')).toMatchObject({ search: { resourceId: invoiceId } });
  expect(linkProps.findLast(({ to }) => to === '/ukoly')).toMatchObject({ search: { resourceId: taskId } });
  expect(new Set(resourceLinkCalls().map(({ params }) => params?.['resourceType']))).toEqual(new Set(['stock-item']));
  // The type is translated context in the row; the technical owner key is never visible.
  expect(screen.queryByText('finance.billing.invoice')).toBeNull();
  expect(screen.queryByText('work.tasks.task')).toBeNull();
  // A flat list is deliberate: the exact server order survives across families, so a higher-ranked hit is never moved
  // below a looser family by a fixed section order.
  expect(renderedRows().map(({ textContent }) => textContent)).toEqual([
    'Novák skladOther records',
    'Faktura NovákInvoices',
    'Zavolat NovákoviTasks',
  ]);
  expect(screen.queryByRole('region', { name: 'Tasks' })).toBeNull();
});

test('a family selection is a server navigation carrying the query, never a local filter', () => {
  useLoaderDataMock.mockReturnValue({
    filters: {
      availableFamilies: [
        { groups: ['counterparty'], key: 'companies' },
        { groups: ['task'], key: 'work' },
      ],
      selectedFamilies: [],
    },
    query: 'novák',
    response: { partial: false, results: [resourceHit('work.tasks', 'work.tasks.task', plainResourceId, 'Úkol')] },
    shell: authenticatedShell(),
    state: 'ready',
  } satisfies SearchPageModel);
  render(<SearchPage />);

  const work = screen.getByRole('button', { name: 'Tasks' });
  expect(work.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(work);
  expect(navigateMock).toHaveBeenCalledWith({
    replace: true,
    search: { families: 'work', q: 'novák' },
    to: '.',
  });
});

test('clearing the last selected family keeps the query and drops the filter field', () => {
  useLoaderDataMock.mockReturnValue({
    filters: {
      availableFamilies: [{ groups: ['task'], key: 'work' }],
      selectedFamilies: ['work'],
    },
    query: 'novák',
    response: { partial: false, results: [resourceHit('work.tasks', 'work.tasks.task', plainResourceId, 'Úkol')] },
    shell: authenticatedShell(),
    state: 'ready',
  } satisfies SearchPageModel);
  render(<SearchPage />);

  const work = screen.getByRole('button', { name: 'Tasks' });
  expect(work.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(work);
  expect(navigateMock).toHaveBeenCalledWith({ replace: true, search: { q: 'novák' }, to: '.' });
});

test('a relationship row opens its owner record and shows at most two owner badges', () => {
  useLoaderDataMock.mockReturnValue({
    filters: emptyFilters,
    query: 'acme',
    response: {
      partial: false,
      results: [counterpartyHit({ alias: true, archived: true, collision: true, roles: ['CUSTOMER', 'SUPPLIER'] })],
    },
    shell: authenticatedShell(),
    state: 'ready',
  } satisfies SearchPageModel);
  render(<SearchPage />);

  const link = screen.getByRole('link', { name: /Acme s\.r\.o\./u });
  expect(link.textContent).toContain('Customers and suppliers');
  expect(link.getAttribute('href')).toBe('/en/prodej/zakaznici/00000000-0000-4000-8000-000000000502');
  // Priority order, cut at two: reconciliation and archive change what the person does next.
  expect(screen.getByText('Reconciliation required')).toBeTruthy();
  expect(screen.getByText('Archived')).toBeTruthy();
  expect(screen.queryByText('Alias match')).toBeNull();
  expect(screen.queryByText('Customer')).toBeNull();
  expect(screen.queryByText('Supplier')).toBeNull();
});

test('each result is one comfortable list row with a visible keyboard focus treatment', () => {
  render(<SearchPage />);

  const rows = renderedRows();
  expect(rows).toHaveLength(1);
  for (const row of rows) {
    expect(row.tagName).toBe('LI');
    expect(row.parentElement?.tagName).toBe('UL');
    // The shared row owns the <li>; the page must not wrap it in a second list.
    expect(row.querySelector('li, ul, ol')).toBeNull();
  }
  const link = screen.getByRole('link', { name: /Unit 1/u });
  expect(link.className).toContain('px-250');
  expect(link.className).toContain('focus-visible:ring-2');
  // A link in a mixed list is described by the record family it belongs to, not by colour alone.
  expect(link.textContent).toContain('Unit 1');
  expect(link.textContent).toContain('Other records');
});

test('the answered page names the query and the company and tenant it searched', () => {
  render(<SearchPage />);

  // One scope line: what was searched and where the answer was authorized, so a shared page explains itself.
  expect(screen.getAllByRole('term').map((term) => [term.textContent, term.nextElementSibling?.textContent])).toEqual([
    ['Search', 'unit'],
    ['Legal Entity', 'Alpha company'],
    ['Current tenant', 'Alpha tenant'],
  ]);
});

test('a matched title highlights the query without changing the visible record name', () => {
  render(<SearchPage />);

  expect(screen.getByRole('link', { name: /Unit 1/u })).toBeTruthy();
  expect(screen.getByText('Unit').tagName).toBe('MARK');
  expect(renderedRows()[0]?.textContent).toContain('Unit 1');
});

test('an empty result set names the query and exposes no resource affordance', () => {
  useLoaderDataMock.mockReturnValue({
    filters: emptyFilters,
    query: 'unit',
    response: { partial: false, results: [] },
    shell: authenticatedShell(),
    state: 'ready',
  } satisfies SearchPageModel);
  render(<SearchPage />);

  expect(screen.getByText('Nothing found for “unit”.')).toBeTruthy();
  expect(screen.queryByText('No authorized results found.')).toBeNull();
  expect(resourceLinkCalls()).toHaveLength(0);
  expect(renderedRows()).toHaveLength(0);
});

test('a page opened without a query invites a search instead of claiming that nothing was found', () => {
  useLoaderDataMock.mockReturnValue({
    filters: emptyFilters,
    query: '',
    response: { partial: false, results: [] },
    shell: authenticatedShell(),
    state: 'ready',
  } satisfies SearchPageModel);
  render(<SearchPage />);

  expect(screen.getByText('Search clients, tasks, invoices, contracts…')).toBeTruthy();
  expect(screen.queryByText('No authorized results found.')).toBeNull();
  expect(screen.queryByText('Nothing found for “”.')).toBeNull();
  // The scope still explains the authorized context; there is no query term to name yet.
  expect(screen.getAllByRole('term').map((term) => [term.textContent, term.nextElementSibling?.textContent])).toEqual([
    ['Legal Entity', 'Alpha company'],
    ['Current tenant', 'Alpha tenant'],
  ]);
  expect(renderedRows()).toHaveLength(0);
});

test('an incomplete answer says so instead of claiming that nothing was found', () => {
  useLoaderDataMock.mockReturnValue({
    filters: emptyFilters,
    query: 'unit',
    response: { partial: true, results: [] },
    shell: authenticatedShell(),
    state: 'ready',
  } satisfies SearchPageModel);
  render(<SearchPage />);

  expect(screen.getByText('Some search providers are temporarily unavailable.')).toBeTruthy();
  expect(screen.getByText('No authorized results found.')).toBeTruthy();
  expect(screen.queryByText('Nothing found for “unit”.')).toBeNull();
});

test('a refined query shows only the searching state, never the previous answer', () => {
  routerState.current = pendingRouterState('/en/search?q=nov', '/en/search?q=unit');
  render(<SearchPage />);

  expect(screen.getByText('Searching…')).toBeTruthy();
  // The scope names the query that is loading, not the previous answer's query.
  expect(screen.getAllByRole('term').map((term) => [term.textContent, term.nextElementSibling?.textContent])).toEqual([
    ['Search', 'nov'],
    ['Legal Entity', 'Alpha company'],
    ['Current tenant', 'Alpha tenant'],
  ]);
  expect(screen.queryByText('unit')).toBeNull();
  expect(screen.queryByRole('link', { name: /Unit 1/u })).toBeNull();
  expect(screen.queryByText('Other records')).toBeNull();
  expect(renderedRows()).toHaveLength(0);
  expect(resourceLinkCalls()).toHaveLength(0);
});

test('navigating away is not presented as a pending search of this page', () => {
  routerState.current = {
    location: routerLocation('/en/profil', '/en/profil'),
    resolvedLocation: routerLocation('/en/search?q=unit', '/en/search'),
  };
  render(<SearchPage />);

  expect(screen.queryByText('Searching…')).toBeNull();
  expect(screen.getByRole('link', { name: /Unit 1/u })).toBeTruthy();
});

test('an unavailable search points to the agendas and exposes no resource affordance', () => {
  useLoaderDataMock.mockReturnValue({
    query: 'unit',
    shell: authenticatedShell(),
    state: 'unavailable',
  } satisfies SearchPageModel);
  render(<SearchPage />);

  expect(screen.getAllByText('Search within an agenda').length).toBeGreaterThan(0);
  expect(screen.getByText('Open an authorized agenda and use its search.')).toBeTruthy();
  expect(resourceLinkCalls()).toHaveLength(0);
  expect(renderedRows()).toHaveLength(0);
});

test('a browser without a live session goes to sign-in instead of a bare error line', () => {
  useLoaderDataMock.mockReturnValue({
    query: 'faktura',
    shell: { reason: 'account_forbidden', state: 'anonymous' },
    state: 'selection_required',
  } satisfies SearchPageModel);
  render(<SearchPage />);

  expect(navigateMock).toHaveBeenCalledWith({ href: '/en/login?reason=account_forbidden', replace: true });
  expect(resourceLinkCalls()).toHaveLength(0);
});

test('a closed shell state exposes no navigable affordance at all', () => {
  useLoaderDataMock.mockReturnValue({
    query: 'unit',
    shell: { state: 'unavailable' },
    state: 'unavailable',
  } satisfies SearchPageModel);
  render(<SearchPage />);

  expect(screen.getByText('Dashboard unavailable')).toBeTruthy();
  expect(screen.queryAllByRole('link')).toHaveLength(0);
  expect(localizedLinkCalls).toHaveLength(0);
});

test('a stale search release exposes only the reload message', () => {
  useLoaderDataMock.mockReturnValue({
    query: 'unit',
    shell: { state: 'reload_required' },
    state: 'reload_required',
  } satisfies SearchPageModel);
  render(<SearchPage />);

  expect(screen.getByText('Reload this page to continue')).toBeTruthy();
  expect(screen.queryAllByRole('link')).toHaveLength(0);
  expect(resourceLinkCalls()).toHaveLength(0);
});
