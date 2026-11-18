import { cleanup, screen } from '@testing-library/react';
import { Effect, Schema } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';

import {
  AppIdSchema,
  GroupKeySchema,
  LegalEntityIdSchema,
  ModuleIdSchema,
  PrincipalIdSchema,
  ResourceIdSchema,
  TenantIdSchema,
} from '../../../../shared/browser-api.ts';
import type { HomePageModel } from '../../../../src/routes/[lang]/home-page-model.ts';
import type { SearchPageModel } from '../../../../src/routes/[lang]/search/search-page-model.ts';
import SearchPage from '../../../../src/routes/[lang]/search/page.tsx';
import { shellTestCopy } from '../../../support/shell-i18n.tsx';
import type { ShellLanguage } from '../../../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../../../support/shell-router.tsx';

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
  'shell.search.empty': 'No results',
  'shell.search.label': 'Search this legal entity',
  'shell.search.selection_required': 'Select a legal entity first',
  'shell.search.submit': 'Search',
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
    items: [
      {
        appId: inventoryAppId,
        enabled: true,
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
  selectedLegalEntityId: legalEntityId,
  state: 'authenticated',
  tenants: {
    items: [{ name: 'Alpha tenant', tenantId }],
    state: 'available',
  },
});

const readyModel = (resourceType: string, resourceId: typeof plainResourceId): SearchPageModel => ({
  query: 'unit',
  response: {
    partial: false,
    results: [
      {
        kind: 'resource',
        ref: { moduleId: inventoryModuleId, resourceId, resourceType },
        title: 'Unit 1',
      },
    ],
  },
  shell: authenticatedShell(),
  state: 'ready',
});

/** The search route of a real router, loading the given model, in the given language. */
const renderSearch = (model: SearchPageModel, language: ShellLanguage = 'en') =>
  renderShellRoute(
    makeShellRouter({
      page: { component: SearchPage, loaderData: () => model, path: 'search' },
      url: `/${language}/search?q=unit`,
    }),
    shellTestCopy(language, copy),
  );

/** Links the page rendered into a resource route, in any language. */
const resourceLinks = () =>
  screen
    .queryAllByRole('link')
    .filter((link) => /^\/(?:en\/resources|cs\/zdroje)\//u.test(link.getAttribute('href') ?? ''));

afterEach(cleanup);

it.effect('a search result links to the localised resource route of its own reference', () =>
  Effect.gen(function* resultLink() {
    yield* renderSearch(readyModel('stock-item', plainResourceId));

    expect(resourceLinks()).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Unit 1' }).getAttribute('href')).toBe(
      '/en/resources/inventory.stock/stock-item/unit-1',
    );
  }),
);

it.effect('a search result resolves the Czech resource route from the same canonical target', () =>
  Effect.gen(function* czechResultLink() {
    yield* renderSearch(readyModel('stock-item', plainResourceId), 'cs');

    expect(screen.getByRole('link', { name: 'Unit 1' }).getAttribute('href')).toBe(
      '/cs/zdroje/inventory.stock/stock-item/unit-1',
    );
  }),
);

it.effect('resource path segments stay percent-encoded per segment', () =>
  Effect.gen(function* encodedSegments() {
    yield* renderSearch(readyModel('stock item', awkwardResourceId));

    expect(screen.getByRole('link', { name: 'Unit 1' }).getAttribute('href')).toBe(
      '/en/resources/inventory.stock/stock%20item/unit%20%231%2F2',
    );
  }),
);

it.effect('an empty result set exposes no resource affordance', () =>
  Effect.gen(function* emptyResults() {
    yield* renderSearch({
      query: 'unit',
      response: { partial: false, results: [] },
      shell: authenticatedShell(),
      state: 'ready',
    });

    expect(screen.getByText('No results')).toBeTruthy();
    expect(resourceLinks()).toHaveLength(0);
  }),
);

it.effect('an unavailable search exposes no resource affordance', () =>
  Effect.gen(function* unavailableSearch() {
    yield* renderSearch({
      query: 'unit',
      shell: authenticatedShell(),
      state: 'unavailable',
    });

    expect(screen.getByText('Search unavailable')).toBeTruthy();
    expect(resourceLinks()).toHaveLength(0);
  }),
);

it.effect('a closed shell state exposes no navigable affordance at all', () =>
  Effect.gen(function* closedShell() {
    yield* renderSearch({
      query: 'unit',
      shell: { state: 'unavailable' },
      state: 'unavailable',
    });

    expect(screen.getByText('Dashboard unavailable')).toBeTruthy();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  }),
);

it.effect('a stale search release exposes only the reload message', () =>
  Effect.gen(function* staleRelease() {
    yield* renderSearch({
      query: 'unit',
      shell: { state: 'reload_required' },
      state: 'reload_required',
    });

    expect(screen.getByText('Reload this page to continue')).toBeTruthy();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  }),
);
