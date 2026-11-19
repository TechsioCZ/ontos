import { networkIdle, networkQuietExcept } from '@app/shared-contracts/testing/http-double';
import type { CoreSearchPresentationEntry } from '@app/core-runtime/search-contract';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { RouterProvider } from '@modern-js/plugin-tanstack/runtime';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, expect, it, rstest } from 'effect-rstest';

import {
  AppIdSchema,
  EntrypointKeySchema,
  GroupKeySchema,
  LegalEntityIdSchema,
  ModuleIdSchema,
  PrincipalIdSchema,
  ResourceIdSchema,
  TenantIdSchema,
} from '../../../../shared/browser-api.ts';
import type {
  ShellSearchPayload,
  ShellSearchPresentationInventory,
  ShellSearchResponse,
  ShellSearchResult,
} from '../../../../shared/browser-api.ts';
import type { HomePageModel } from '../../../../src/routes/[lang]/home-page-model.ts';
import type { SearchFilterPlan, SearchPageModel } from '../../../../src/routes/[lang]/search/search-page-model.ts';
import SearchPage from '../../../../src/routes/[lang]/search/page.tsx';
import { shellSearchPresentationIndex } from '../../../../src/routes/shell-search-resource-types.ts';
import { makeShellBff } from '../../../support/shell-bff-double.ts';
import type { ShellBffScript } from '../../../support/shell-bff-double.ts';
import { ShellI18n, shellTestCopy } from '../../../support/shell-i18n.tsx';
import type { ShellLanguage } from '../../../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../../../support/shell-router.tsx';
import type { ShellRouter } from '../../../support/shell-router.tsx';

const copy = {
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
  'shell.search.groups.product': 'Products',
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
};

const principalId = Schema.decodeUnknownSync(PrincipalIdSchema)('00000000-0000-4000-8000-000000000001');
const tenantId = Schema.decodeUnknownSync(TenantIdSchema)('00000000-0000-4000-8000-000000000101');
const legalEntityId = Schema.decodeUnknownSync(LegalEntityIdSchema)('00000000-0000-4000-8000-000000000201');
const inventoryAppId = Schema.decodeUnknownSync(AppIdSchema)('inventory-app');
const navigationGroupKey = Schema.decodeUnknownSync(GroupKeySchema)('shell.navigation.modules');
const inventoryModuleId = Schema.decodeUnknownSync(ModuleIdSchema)('inventory.stock');
const plainResourceId = Schema.decodeUnknownSync(ResourceIdSchema)('unit-1');
const awkwardResourceId = Schema.decodeUnknownSync(ResourceIdSchema)('unit #1/2');

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
    ],
    moduleIds: [inventoryModuleId],
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

const compositionRevision = '1'.repeat(64);
const presentationMetadata = (key: string, order: number, cs: string, en: string) => ({
  icon: 'icon-[mdi--file-outline]' as const,
  key,
  label: { cs, en },
  order,
});

interface PresentationRoute {
  readonly groupLabel: string;
  readonly idEncoding: 'native' | 'selected_company_dot_prefix';
  readonly idFormat: 'opaque' | 'uuid';
  readonly kind: 'path' | 'query';
  readonly ownerModuleId: string;
  readonly pageKey: string;
  readonly parameterName: string;
  readonly resourceType: string;
  readonly routePath: string;
}

const presentationRoutes: readonly PresentationRoute[] = [
  {
    groupLabel: 'Customers and suppliers',
    idEncoding: 'native',
    idFormat: 'uuid',
    kind: 'path',
    ownerModuleId: 'party.registry',
    pageKey: 'customers',
    parameterName: 'id',
    resourceType: 'party.registry.counterparty',
    routePath: '/prodej/zakaznici/:id',
  },
  {
    groupLabel: 'Tasks',
    idEncoding: 'native',
    idFormat: 'opaque',
    kind: 'query',
    ownerModuleId: 'work.tasks',
    pageKey: 'tasks',
    parameterName: 'resourceId',
    resourceType: 'work.tasks.task',
    routePath: '/ukoly',
  },
  {
    groupLabel: 'Invoices',
    idEncoding: 'native',
    idFormat: 'opaque',
    kind: 'query',
    ownerModuleId: 'finance.billing',
    pageKey: 'finance',
    parameterName: 'resourceId',
    resourceType: 'finance.billing.invoice',
    routePath: '/finance',
  },
  {
    groupLabel: 'Products',
    idEncoding: 'selected_company_dot_prefix',
    idFormat: 'opaque',
    kind: 'path',
    ownerModuleId: 'demo.merchandise',
    pageKey: 'products',
    parameterName: 'id',
    resourceType: 'demo.merchandise.product',
    routePath: '/provoz/produkty/:id',
  },
];

interface MutableSearchPresentation {
  family: ReturnType<typeof presentationMetadata>;
  group: ReturnType<typeof presentationMetadata>;
  record: {
    pageKey: string;
    selector: {
      idEncoding: 'native' | 'selected_company_dot_prefix';
      idFormat: 'opaque' | 'uuid';
      kind: 'path' | 'query';
      parameterName: string;
    };
  };
  refinement?: { kind: 'matched_variant'; parameterName: string };
  scope: 'company';
}

const presentationEntryFor = (route: PresentationRoute): CoreSearchPresentationEntry => {
  const ownerModuleId = Schema.decodeUnknownSync(ModuleIdSchema)(route.ownerModuleId);
  const presentation: MutableSearchPresentation = {
    family: presentationMetadata(
      route.ownerModuleId === 'party.registry' ? 'companies' : route.ownerModuleId,
      10,
      route.resourceType,
      route.resourceType,
    ),
    group: presentationMetadata(route.groupLabel, 10, route.groupLabel, route.groupLabel),
    record: {
      pageKey: route.pageKey,
      selector: {
        idEncoding: route.idEncoding,
        idFormat: route.idFormat,
        kind: route.kind,
        parameterName: route.parameterName,
      },
    },
    scope: 'company',
  };
  if (route.resourceType === 'demo.merchandise.product') {
    presentation.refinement = { kind: 'matched_variant', parameterName: 'variantId' };
  }
  return {
    ownerModuleId,
    presentation,
    resourceType: route.resourceType,
    searchKey: `${route.ownerModuleId}.search`,
  };
};

const presentationInventory = {
  business: {
    compositionRevision,
    entries: presentationRoutes.map(presentationEntryFor),
    schemaVersion: '1' as const,
  },
  pages: presentationRoutes.map((route) => ({
    ownerModuleId: Schema.decodeUnknownSync(ModuleIdSchema)(route.ownerModuleId),
    pageKey: route.pageKey,
    routePath: route.routePath,
  })),
} satisfies ShellSearchPresentationInventory;
const searchIndex = shellSearchPresentationIndex(presentationInventory, compositionRevision);
if (searchIndex === undefined) {
  throw new Error('search page fixture inventory must be current');
}

const familyFixture = (
  key: string,
  label: string,
  order: number,
  resourceTypes: readonly string[],
): SearchFilterPlan['availableFamilies'][number] => ({
  family: {
    ...presentationMetadata(key, order, label, label),
    groups: [],
    resourceTypes: [...resourceTypes],
  },
  key,
});

const filterPlan = (
  families: readonly SearchFilterPlan['availableFamilies'][number][],
  selectedFamilies: readonly string[],
): SearchFilterPlan => ({ availableFamilies: families, selectedFamilies });

const readyModel = (resourceType: string, resourceId: typeof plainResourceId): SearchPageModel => ({
  filters: emptyFilters,
  index: searchIndex,
  query: 'unit',
  response: {
    partial: false,
    presentation: presentationInventory,
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

const variantProductHit = (): ShellSearchResult => ({
  kind: 'resource',
  matchedVariant: { id: 'item-6692', name: 'Adaptér 18 mm', sku: '18kop009' },
  ref: {
    moduleId: Schema.decodeUnknownSync(ModuleIdSchema)('demo.merchandise'),
    resourceId: Schema.decodeUnknownSync(ResourceIdSchema)(`${legalEntityId}.product-1`),
    resourceType: 'demo.merchandise.product',
    tenantId,
  },
  selectedLegalEntityId: legalEntityId,
  title: 'Product parent',
});

const queryModel = (query: string, title: string): SearchPageModel => ({
  filters: emptyFilters,
  index: searchIndex,
  query,
  response: {
    partial: false,
    presentation: presentationInventory,
    results: [resourceHit('work.tasks', 'work.tasks.task', plainResourceId, title)],
  },
  shell: authenticatedShell(),
  state: 'ready',
});

/**
 * The search route of a real router in the given language, standing on `url`. The first load answers `model`; a
 * later navigation's loader is still running, so the page answers it with its own search, as it does in the browser
 * while the framework loader has not re-run.
 */
const renderSearch = (
  model: SearchPageModel,
  {
    language = 'en',
    url = `/${language}/search?q=unit`,
  }: { readonly language?: ShellLanguage; readonly url?: string } = {},
) =>
  Effect.gen(function* renderSearchRoute() {
    window.history.replaceState(null, '', url);
    let loads = 0;
    const router = makeShellRouter({
      page: {
        component: SearchPage,
        loaderData: () => {
          loads += 1;
          return loads === 1 ? model : Promise.withResolvers<SearchPageModel>().promise;
        },
        path: 'search',
      },
      url,
    });
    const translations = shellTestCopy(language, copy);
    const view = yield* renderShellRoute(router, translations);
    /** Renders the same route again, as a parent re-render would. */
    const rerender = () =>
      view.rerender(
        <ShellI18n translations={translations}>
          <RouterProvider router={router} />
        </ShellI18n>,
      );
    return { rerender, router };
  });

/** A person typing a new query or following a search link: a new history entry the router answers. */
const visitSearch = (router: ShellRouter, href: string) =>
  Effect.promise(async () => {
    router.history.push(href);
    await Promise.resolve();
  });

/** The Shell BFF answering the page's own searches with `search`. */
const searchBff = (search: NonNullable<ShellBffScript['search']>) => makeShellBff({ search });
const searches = (bff: ReturnType<typeof searchBff>) =>
  bff.requests.filter((received) => received.endpoint === 'search');
const answerOf = (title: string): ShellSearchResponse => ({
  partial: false,
  results: [resourceHit('work.tasks', 'work.tasks.task', plainResourceId, title)],
});

/** Links the page rendered into a resource route, in any language. */
const resourceLinks = () =>
  screen
    .queryAllByRole('link')
    .filter((link) => /^\/(?:en\/resources|cs\/zdroje)\//u.test(link.getAttribute('href') ?? ''));

/** Rows the page rendered, in document order. */
const renderedRows = () => [...document.querySelectorAll('[data-shell-search-result]')];
/** The scope line: what was searched and where the answer was authorized. */
const scopeTerms = () =>
  screen.getAllByRole('term').map((term) => [term.textContent, term.nextElementSibling?.textContent]);

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

it.effect('a search result links to the localised resource route of its own reference', () =>
  Effect.gen(function* resultLink() {
    yield* renderSearch(readyModel('stock-item', plainResourceId));

    expect(resourceLinks()).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Unit 1/u }).getAttribute('href')).toBe(
      '/en/resources/inventory.stock/stock-item/unit-1',
    );
  }),
);

it.effect('a search result resolves the Czech resource route from the same canonical target', () =>
  Effect.gen(function* czechResultLink() {
    yield* renderSearch(readyModel('stock-item', plainResourceId), { language: 'cs' });

    expect(screen.getByRole('link', { name: /Unit 1/u }).getAttribute('href')).toBe(
      '/cs/zdroje/inventory.stock/stock-item/unit-1',
    );
  }),
);

it.effect('resource path segments stay percent-encoded per segment', () =>
  Effect.gen(function* encodedSegments() {
    yield* renderSearch(readyModel('stock item', awkwardResourceId));

    expect(screen.getByRole('link', { name: /Unit 1/u }).getAttribute('href')).toBe(
      '/en/resources/inventory.stock/stock%20item/unit%20%231%2F2',
    );
  }),
);

it.effect('results keep the server-wide order across families and name each type', () =>
  Effect.gen(function* serverOrder() {
    const invoiceId = Schema.decodeUnknownSync(ResourceIdSchema)('00000000-0000-4000-8000-000000000401');
    const taskId = Schema.decodeUnknownSync(ResourceIdSchema)('00000000-0000-4000-8000-000000000402');
    yield* renderSearch(
      {
        filters: emptyFilters,
        index: searchIndex,
        query: 'novák',
        response: {
          partial: false,
          presentation: presentationInventory,
          results: [
            resourceHit('inventory.stock', 'stock-item', plainResourceId, 'Novák sklad'),
            resourceHit('finance.billing', 'finance.billing.invoice', invoiceId, 'Faktura Novák'),
            resourceHit('work.tasks', 'work.tasks.task', taskId, 'Zavolat Novákovi'),
          ],
        },
        shell: authenticatedShell(),
        state: 'ready',
      },
      { url: '/en/search?q=novák' },
    );

    // Each hit opens its owner's record page; only a hit without one opens the Shell resource route.
    expect(screen.getByRole('link', { name: /Faktura Novák/u }).getAttribute('href')).toBe(
      `/en/finance?resourceId=${invoiceId}`,
    );
    expect(screen.getByRole('link', { name: /Zavolat Novákovi/u }).getAttribute('href')).toBe(
      `/en/ukoly?resourceId=${taskId}`,
    );
    expect(resourceLinks().map((link) => link.getAttribute('href'))).toEqual([
      '/en/resources/inventory.stock/stock-item/unit-1',
    ]);
    // The type is translated context in the row; the technical owner key is never visible.
    expect(screen.queryByText('finance.billing.invoice')).toBeNull();
    expect(screen.queryByText('work.tasks.task')).toBeNull();
    // A flat list is deliberate: the exact server order survives across families, so a higher-ranked hit is never
    // moved below a looser family by a fixed section order.
    expect(renderedRows().map(({ textContent }) => textContent)).toEqual([
      'Novák skladOther records',
      'Faktura NovákInvoices',
      'Zavolat NovákoviTasks',
    ]);
    expect(screen.queryByRole('region', { name: 'Tasks' })).toBeNull();
  }),
);

const taskFilterModel = (selectedFamilies: readonly string[]): SearchPageModel => ({
  filters: filterPlan(
    [
      familyFixture('companies', 'Customers and suppliers', 10, ['party.registry.counterparty']),
      familyFixture('work', 'Tasks', 20, ['work.tasks.task']),
    ],
    selectedFamilies,
  ),
  query: 'novák',
  response: { partial: false, results: [resourceHit('work.tasks', 'work.tasks.task', plainResourceId, 'Úkol')] },
  shell: authenticatedShell(),
  state: 'ready',
});

it.effect('a family selection is a server navigation carrying the query, never a local filter', () => {
  const bff = searchBff(() => Effect.never);
  return Effect.gen(function* familySelection() {
    const { router } = yield* renderSearch(taskFilterModel([]), { url: '/en/search?q=novák' });

    const work = screen.getByRole('button', { name: 'Tasks' });
    expect(work.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(work);
    yield* Effect.promise(() => Promise.resolve());
    expect(router.state.location.pathname).toBe('/en/search');
    expect(router.state.location.search).toEqual({ families: 'work', q: 'novák' });
  }).pipe(Effect.provide(bff.browser));
});

it.effect('clearing the last selected family keeps the query and drops the filter field', () => {
  const bff = searchBff(() => Effect.never);
  return Effect.gen(function* clearFamily() {
    const { router } = yield* renderSearch(taskFilterModel(['work']), { url: '/en/search?q=novák&families=work' });

    const work = screen.getByRole('button', { name: 'Tasks' });
    expect(work.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(work);
    yield* Effect.promise(() => Promise.resolve());
    expect(router.state.location.search).toEqual({ q: 'novák' });
  }).pipe(Effect.provide(bff.browser));
});

it.effect('a relationship row opens its owner record and shows at most two owner badges', () =>
  Effect.gen(function* relationshipRow() {
    yield* renderSearch(
      {
        filters: emptyFilters,
        index: searchIndex,
        query: 'acme',
        response: {
          partial: false,
          presentation: presentationInventory,
          results: [counterpartyHit({ alias: true, archived: true, collision: true, roles: ['CUSTOMER', 'SUPPLIER'] })],
        },
        shell: authenticatedShell(),
        state: 'ready',
      },
      { url: '/en/search?q=acme' },
    );

    const link = screen.getByRole('link', { name: /Acme s\.r\.o\./u });
    expect(link.textContent).toContain('Customers and suppliers');
    expect(link.getAttribute('href')).toBe('/en/prodej/zakaznici/00000000-0000-4000-8000-000000000502');
    // Priority order, cut at two: reconciliation and archive change what the person does next.
    expect(screen.getByText('Reconciliation required')).toBeTruthy();
    expect(screen.getByText('Archived')).toBeTruthy();
    expect(screen.queryByText('Alias match')).toBeNull();
    expect(screen.queryByText('Customer')).toBeNull();
    expect(screen.queryByText('Supplier')).toBeNull();
  }),
);

it.effect('each result is one comfortable list row with a visible keyboard focus treatment', () =>
  Effect.gen(function* comfortableRow() {
    yield* renderSearch(readyModel('stock-item', plainResourceId));

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
  }),
);

it.effect('the answered page names the query and the company and tenant it searched', () =>
  Effect.gen(function* answeredScope() {
    yield* renderSearch(readyModel('stock-item', plainResourceId));

    // One scope line: what was searched and where the answer was authorized, so a shared page explains itself.
    expect(scopeTerms()).toEqual([
      ['Search', 'unit'],
      ['Legal Entity', 'Alpha company'],
      ['Current tenant', 'Alpha tenant'],
    ]);
  }),
);

it.effect('a matched title highlights the query without changing the visible record name', () =>
  Effect.gen(function* highlightedTitle() {
    yield* renderSearch(readyModel('stock-item', plainResourceId));

    expect(screen.getByRole('link', { name: /Unit 1/u })).toBeTruthy();
    expect(screen.getByText('Unit').tagName).toBe('MARK');
    expect(renderedRows()[0]?.textContent).toContain('Unit 1');
  }),
);

it.effect('an empty result set names the query and exposes no resource affordance', () =>
  Effect.gen(function* emptyResults() {
    yield* renderSearch({
      filters: emptyFilters,
      query: 'unit',
      response: { partial: false, results: [] },
      shell: authenticatedShell(),
      state: 'ready',
    });

    expect(screen.getByText('Nothing found for “unit”.')).toBeTruthy();
    expect(resourceLinks()).toHaveLength(0);
    expect(renderedRows()).toHaveLength(0);
  }),
);

it.effect('a page opened without a query invites a search instead of claiming that nothing was found', () =>
  Effect.gen(function* noQuery() {
    yield* renderSearch(
      {
        filters: emptyFilters,
        query: '',
        response: { partial: false, results: [] },
        shell: authenticatedShell(),
        state: 'ready',
      },
      { url: '/en/search' },
    );

    expect(screen.getByText('Search clients, tasks, invoices, contracts…')).toBeTruthy();
    expect(screen.queryByText('Nothing found for “”.')).toBeNull();
    // The scope still explains the authorized context; there is no query term to name yet.
    expect(scopeTerms()).toEqual([
      ['Legal Entity', 'Alpha company'],
      ['Current tenant', 'Alpha tenant'],
    ]);
    expect(renderedRows()).toHaveLength(0);
  }),
);

it.effect('an incomplete answer says so instead of claiming that nothing was found', () =>
  Effect.gen(function* partialAnswer() {
    yield* renderSearch({
      filters: emptyFilters,
      query: 'unit',
      response: { partial: true, results: [] },
      shell: authenticatedShell(),
      state: 'ready',
    });

    expect(screen.getByText('Some search providers are temporarily unavailable.')).toBeTruthy();
    expect(screen.getByText('No authorized results found.')).toBeTruthy();
    expect(screen.queryByText('Nothing found for “unit”.')).toBeNull();
  }),
);

it.effect('a refined query shows only the searching state, never the previous answer', () => {
  const bff = searchBff(() => Effect.never);
  return Effect.gen(function* refinedQuery() {
    const { router } = yield* renderSearch(readyModel('stock-item', plainResourceId));
    yield* visitSearch(router, '/en/search?q=nov');

    expect(yield* Effect.promise(() => screen.findByText('Searching…'))).toBeTruthy();
    // The scope names the query that is loading, not the previous answer's query.
    expect(scopeTerms()).toEqual([
      ['Search', 'nov'],
      ['Legal Entity', 'Alpha company'],
      ['Current tenant', 'Alpha tenant'],
    ]);
    yield* networkQuietExcept(1);
    expect(screen.queryByText('unit')).toBeNull();
    expect(screen.queryByRole('link', { name: /Unit 1/u })).toBeNull();
    expect(screen.queryByText('Other records')).toBeNull();
    expect(renderedRows()).toHaveLength(0);
    expect(resourceLinks()).toHaveLength(0);
  }).pipe(Effect.provide(bff.browser));
});

it.effect('navigating away is not presented as a pending search of this page', () =>
  Effect.gen(function* navigatingAway() {
    const entered = Promise.withResolvers<boolean>();
    const destination = Promise.withResolvers<boolean>();
    const { router } = yield* renderSearch(readyModel('stock-item', plainResourceId));
    router.routesByPath['/$lang'].update({
      loader: () => {
        entered.resolve(true);
        return destination.promise;
      },
    });
    yield* visitSearch(router, '/en');
    yield* Effect.promise(() => entered.promise);
    // The real destination loader has started, but has not committed over the search page yet.
    expect(screen.queryByText('Searching…')).toBeNull();
    expect(screen.getByRole('link', { name: /Unit 1/u })).toBeTruthy();
    destination.resolve(true);
  }),
);

it.effect('an unavailable search points to the agendas and exposes no resource affordance', () =>
  Effect.gen(function* unavailableSearch() {
    yield* renderSearch({ query: 'unit', shell: authenticatedShell(), state: 'unavailable' });

    expect(screen.getAllByText('Search within an agenda').length).toBeGreaterThan(0);
    expect(screen.getByText('Open an authorized agenda and use its search.')).toBeTruthy();
    expect(resourceLinks()).toHaveLength(0);
    expect(renderedRows()).toHaveLength(0);
  }),
);

it.effect('a browser without a live session goes to sign-in instead of a bare error line', () =>
  Effect.gen(function* signInRedirect() {
    const url = '/en/search?q=faktura';
    window.history.replaceState(null, '', url);
    const router = makeShellRouter({
      page: {
        component: SearchPage,
        loaderData: (): SearchPageModel => ({
          query: 'faktura',
          shell: { reason: 'account_forbidden', state: 'anonymous' },
          state: 'selection_required',
        }),
        path: 'search',
      },
      url,
    });
    const navigations = rstest.spyOn(router, 'navigate');
    yield* renderShellRoute(router, shellTestCopy('en', copy));

    // Sign-in returns to the search the browser stands on.
    expect(navigations).toHaveBeenCalledWith(
      expect.objectContaining({
        href: `/en/login?${new URLSearchParams([
          ['returnTo', url],
          ['reason', 'account_forbidden'],
        ]).toString()}`,
        replace: true,
      }),
    );
    expect(resourceLinks()).toHaveLength(0);
  }),
);

it.effect('a closed shell state exposes no navigable affordance at all', () =>
  Effect.gen(function* closedShell() {
    yield* renderSearch({ query: 'unit', shell: { state: 'unavailable' }, state: 'unavailable' });

    expect(screen.getByText('Dashboard unavailable')).toBeTruthy();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  }),
);

it.effect('a stale search release exposes only the reload message', () =>
  Effect.gen(function* staleRelease() {
    yield* renderSearch({ query: 'unit', shell: { state: 'reload_required' }, state: 'reload_required' });

    expect(screen.getByText('Reload this page to continue')).toBeTruthy();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  }),
);

it.effect('a same-mounted query change shows fresh loading and then the new answer', () =>
  Effect.gen(function* sameMountedQueryChange() {
    const response = yield* Deferred.make<ShellSearchResponse>();
    const bff = searchBff(() => Deferred.await(response));
    yield* Effect.gen(function* changeQuery() {
      const { router } = yield* renderSearch(queryModel('18kop009', 'Definition 18kop009'), {
        url: '/en/search?q=18kop009',
      });
      expect(screen.getByRole('link', { name: /Definition 18kop009/u })).toBeTruthy();

      yield* visitSearch(router, '/en/search?q=ADAPTÉRY');
      expect(yield* Effect.promise(() => screen.findByText('Searching…'))).toBeTruthy();
      yield* networkQuietExcept(1);
      expect(screen.queryByText('Definition 18kop009')).toBeNull();

      yield* Deferred.succeed(response, answerOf('ADAPTÉRY definition'));
      expect(yield* Effect.promise(() => screen.findByRole('link', { name: /ADAPTÉRY definition/u }))).toBeTruthy();
      yield* networkIdle;
    }).pipe(Effect.provide(bff.browser));
    expect(searches(bff)).toEqual([
      expect.objectContaining({
        acceptLanguage: 'en',
        body: { compositionRevision: '1'.repeat(64), query: 'ADAPTÉRY' },
      }),
    ]);
  }),
);

it.effect('a stale answer from the previous same-route query cannot paint', () =>
  Effect.gen(function* stalePriorQuery() {
    const first = yield* Deferred.make<ShellSearchResponse>();
    const second = yield* Deferred.make<ShellSearchResponse>();
    const bff = searchBff((payload: ShellSearchPayload) =>
      payload.query === 'first' ? Deferred.await(first) : Deferred.await(second),
    );
    yield* Effect.gen(function* twoQueries() {
      const { router } = yield* renderSearch(queryModel('initial', 'Initial definition'), {
        url: '/en/search?q=initial',
      });
      expect(screen.getByRole('link', { name: /Initial definition/u })).toBeTruthy();

      yield* visitSearch(router, '/en/search?q=first');
      yield* Effect.promise(() => screen.findByText('Searching…'));
      yield* networkQuietExcept(1);
      yield* visitSearch(router, '/en/search?q=second');
      yield* networkQuietExcept(2);
      yield* Deferred.succeed(first, answerOf('FIRST definition'));
      yield* networkQuietExcept(1);
      expect(screen.queryByRole('link', { name: /FIRST definition/u })).toBeNull();
      expect(screen.getByText('Searching…')).toBeTruthy();

      yield* Deferred.succeed(second, answerOf('SECOND definition'));
      expect(yield* Effect.promise(() => screen.findByRole('link', { name: /SECOND definition/u }))).toBeTruthy();
      yield* networkIdle;
      expect(screen.queryByRole('link', { name: /FIRST definition/u })).toBeNull();
    }).pipe(Effect.provide(bff.browser));
  }),
);

it.effect('back to the first same-route query fetches a fresh answer instead of reusing the loader result', () =>
  Effect.gen(function* backToInitialQuery() {
    const backResponse = yield* Deferred.make<ShellSearchResponse>();
    const bff = searchBff((payload: ShellSearchPayload) =>
      payload.query === 'initial'
        ? Deferred.await(backResponse)
        : Effect.succeed(answerOf(`${payload.query} definition`)),
    );
    yield* Effect.gen(function* backAndForth() {
      const { router } = yield* renderSearch(queryModel('initial', 'Initial definition'), {
        url: '/en/search?q=initial',
      });

      yield* visitSearch(router, '/en/search?q=first');
      expect(yield* Effect.promise(() => screen.findByRole('link', { name: /first definition/u }))).toBeTruthy();

      yield* visitSearch(router, '/en/search?q=initial');
      expect(yield* Effect.promise(() => screen.findByText('Searching…'))).toBeTruthy();
      yield* networkQuietExcept(1);
      expect(screen.queryByRole('link', { name: /first definition/u })).toBeNull();

      yield* Deferred.succeed(backResponse, answerOf('initial definition'));
      expect(yield* Effect.promise(() => screen.findByRole('link', { name: /initial definition/u }))).toBeTruthy();
      yield* networkIdle;
    }).pipe(Effect.provide(bff.browser));
    expect(searches(bff).map(({ body }) => body)).toEqual([
      { compositionRevision: '1'.repeat(64), query: 'first' },
      { compositionRevision: '1'.repeat(64), query: 'initial' },
    ]);
  }),
);

it.effect('clearing the same-route query shows the prompt instead of the previous answer', () => {
  const bff = searchBff(() => Effect.never);
  return Effect.gen(function* clearQuery() {
    const { router } = yield* renderSearch(queryModel('initial', 'Initial definition'), {
      url: '/en/search?q=initial',
    });
    expect(screen.getByRole('link', { name: /Initial definition/u })).toBeTruthy();

    yield* visitSearch(router, '/en/search');
    expect(yield* Effect.promise(() => screen.findByText('Search clients, tasks, invoices, contracts…'))).toBeTruthy();
    yield* networkIdle;
    expect(screen.queryByRole('link', { name: /Initial definition/u })).toBeNull();
    expect(searches(bff)).toEqual([]);
  }).pipe(Effect.provide(bff.browser));
});

it.effect('returning to a resolved query after another pending query fetches fresh and hides the old answer', () =>
  Effect.gen(function* returnToResolvedQuery() {
    const pendingA = yield* Deferred.make<ShellSearchResponse>();
    const secondB = yield* Deferred.make<ShellSearchResponse>();
    let bRequests = 0;
    const bff = searchBff((payload: ShellSearchPayload) => {
      if (payload.query !== 'B') {
        return Deferred.await(pendingA);
      }
      return Effect.suspend(() => {
        bRequests += 1;
        return bRequests === 1 ? Effect.succeed(answerOf('B old answer')) : Deferred.await(secondB);
      });
    });
    yield* Effect.gen(function* bThenAThenB() {
      const { router } = yield* renderSearch(queryModel('initial', 'Initial definition'), {
        url: '/en/search?q=initial',
      });

      yield* visitSearch(router, '/en/search?q=B');
      expect(yield* Effect.promise(() => screen.findByRole('link', { name: /B old answer/u }))).toBeTruthy();

      yield* visitSearch(router, '/en/search?q=A');
      expect(yield* Effect.promise(() => screen.findByText('Searching…'))).toBeTruthy();

      yield* networkQuietExcept(1);

      // Back to B before A resolves: the retained B client answer must not match the new navigation epoch.
      yield* visitSearch(router, '/en/search?q=B');
      expect(screen.getByText('Searching…')).toBeTruthy();
      yield* networkQuietExcept(2);
      expect(screen.queryByRole('link', { name: /B old answer/u })).toBeNull();

      yield* Deferred.succeed(secondB, answerOf('B fresh answer'));
      expect(yield* Effect.promise(() => screen.findByRole('link', { name: /B fresh answer/u }))).toBeTruthy();
      yield* networkQuietExcept(1);
      expect(screen.queryByRole('link', { name: /B old answer/u })).toBeNull();
    }).pipe(Effect.provide(bff.browser));
  }),
);

it.effect('an explicit same-query re-submit invokes a genuinely fresh search', () =>
  Effect.gen(function* sameQueryResubmit() {
    const resubmitted = yield* Deferred.make<ShellSearchResponse>();
    const bff = searchBff(() => Deferred.await(resubmitted));
    yield* Effect.gen(function* resubmit() {
      const { router } = yield* renderSearch(queryModel('initial', 'Initial definition'), {
        url: '/en/search?q=initial',
      });
      expect(screen.getByRole('link', { name: /Initial definition/u })).toBeTruthy();

      // The same URL again is a new history entry with its own navigation key.
      yield* visitSearch(router, '/en/search?q=initial');
      expect(yield* Effect.promise(() => screen.findByText('Searching…'))).toBeTruthy();
      yield* networkQuietExcept(1);
      expect(screen.queryByRole('link', { name: /Initial definition/u })).toBeNull();

      yield* Deferred.succeed(resubmitted, answerOf('Resubmitted answer'));
      expect(yield* Effect.promise(() => screen.findByRole('link', { name: /Resubmitted answer/u }))).toBeTruthy();
      yield* networkIdle;
    }).pipe(Effect.provide(bff.browser));
    expect(searches(bff).map(({ body }) => body)).toEqual([{ compositionRevision: '1'.repeat(64), query: 'initial' }]);
  }),
);

it.effect('a matched product variant shows its own name/SKU and opens the product with the opaque variant target', () =>
  Effect.gen(function* matchedVariant() {
    yield* renderSearch(
      {
        filters: emptyFilters,
        index: searchIndex,
        query: 'adapt',
        response: { partial: false, presentation: presentationInventory, results: [variantProductHit()] },
        shell: authenticatedShell(),
        state: 'ready',
      },
      { url: '/en/search?q=adapt' },
    );

    const link = screen.getByRole('link', { name: /Product parent/u });
    expect(link.textContent).toContain('Adaptér 18 mm');
    expect(link.textContent).toContain('18kop009');
    expect(link.getAttribute('href')).toBe('/en/provoz/produkty/product-1?variantId=item-6692');
  }),
);

it.effect(
  'full results show the approved generic subtitle and archive badge once with the whole accessible record',
  () =>
    Effect.gen(function* subtitleAndArchive() {
      const archived = { ...variantProductHit(), archived: true, subtitle: 'PRJ-2026-14' };
      const plain = {
        ...resourceHit('inventory.stock', 'inventory.stock.item', plainResourceId, 'Bez archivu'),
        archived: false,
      };
      yield* renderSearch(
        {
          filters: emptyFilters,
          index: searchIndex,
          query: 'product',
          response: { partial: false, presentation: presentationInventory, results: [archived, plain] },
          shell: authenticatedShell(),
          state: 'ready',
        },
        { url: '/en/search?q=product' },
      );

      const link = screen.getByRole('link', {
        name: /Product parent.*Products.*PRJ-2026-14.*Adaptér 18 mm.*18kop009.*Archived/u,
      });
      expect(link.getAttribute('aria-label')).toContain('Product parent');
      expect(link.getAttribute('aria-label')).toContain('PRJ-2026-14');
      expect(link.getAttribute('aria-label')).toContain('Adaptér 18 mm');
      expect(link.getAttribute('aria-label')).toContain('18kop009');
      expect(link.textContent?.match(/PRJ-2026-14/gu)).toHaveLength(1);
      expect(screen.getByText('Archived')).toBeTruthy();

      const plainLink = screen.getByRole('link', { name: /Bez archivu/u });
      expect(plainLink.getAttribute('aria-label')).not.toContain('Archived');
    }),
);

const serverRenderedPending = (): SearchPageModel => ({
  query: 'unit',
  shell: authenticatedShell(),
  state: 'pending',
});

it.effect('a server-rendered pending search shows the loading placeholder, never the empty state', () => {
  const bff = searchBff(() => Effect.never);
  return Effect.gen(function* pendingPlaceholder() {
    yield* renderSearch(serverRenderedPending());

    expect(screen.getByText('Searching…')).toBeTruthy();
    yield* networkQuietExcept(1);
    expect(screen.queryByText('Nothing found for “unit”.')).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(renderedRows()).toHaveLength(0);
  }).pipe(Effect.provide(bff.browser));
});

it.effect('a server-rendered pending search runs once in the browser after hydration', () => {
  const bff = searchBff(() =>
    Effect.succeed({
      partial: false,
      results: [resourceHit('inventory.stock', 'stock-item', plainResourceId, 'Unit 1')],
    }),
  );
  return Effect.gen(function* hydratedPendingSearch() {
    const { rerender } = yield* renderSearch(serverRenderedPending());
    expect(yield* Effect.promise(() => screen.findByRole('link', { name: /Unit 1/u }))).toBeTruthy();
    yield* networkIdle;
    expect(searches(bff)).toEqual([
      expect.objectContaining({ acceptLanguage: 'en', body: { compositionRevision: '1'.repeat(64), query: 'unit' } }),
    ]);
    rerender();
    yield* networkIdle;
    expect(searches(bff)).toHaveLength(1);
  }).pipe(Effect.provide(bff.browser));
});
