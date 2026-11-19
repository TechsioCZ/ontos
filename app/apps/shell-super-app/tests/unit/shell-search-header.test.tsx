// @rstest-environment happy-dom
import { settle, waitUntil } from '@app/admin-ui/testing/module-ui';
import { networkIdle } from '@app/shared-contracts/testing/http-double';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { act, cleanup, fireEvent, renderHook, screen } from '@testing-library/react';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, expect, it as test } from 'effect-rstest';

import type {
  ShellSearchPayload,
  ShellSearchPresentationInventory,
  ShellSearchResponse,
  ShellSearchResult,
} from '../../shared/browser-api.ts';
import {
  LegalEntityIdSchema,
  ModuleIdSchema,
  ResourceIdSchema,
  ShellTargetForbiddenProblemSchema,
  TenantIdSchema,
} from '../../shared/browser-api.ts';
import { ShellSearchBar } from '../../src/routes/shell-search-bar.tsx';
import { shellSearchPresentationIndex, shellSearchResultTarget } from '../../src/routes/shell-search-resource-types.ts';
import type { ShellSearchFamilyAvailability } from '../../src/routes/shell-search-match.ts';
import { useShellSearchSuggestions } from '../../src/routes/shell-search-suggestions.ts';
import type {
  ShellSearchSuggestionGroup,
  ShellSearchSuggestionsState,
} from '../../src/routes/shell-search-suggestions.ts';

import type { ReactNode } from 'react';

import { makeShellBff } from '../support/shell-bff-double.ts';
import type { ShellBffScript } from '../support/shell-bff-double.ts';
import { ShellI18n, shellLocaleCopy } from '../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../support/shell-router.tsx';

const noop = (): void => {};
const english = shellLocaleCopy('en');
const ShellCopy = ({ children }: { readonly children: ReactNode }) => (
  <ShellI18n translations={english}>{children}</ShellI18n>
);
const renderBar = (element: ReactNode) =>
  renderShellRoute(makeShellRouter({ page: { component: () => element, path: '/' }, url: '/en' }), english);

const tenantId = Schema.decodeUnknownSync(TenantIdSchema)('00000000-0000-4000-8000-000000000101');
const legalEntityId = Schema.decodeUnknownSync(LegalEntityIdSchema)('00000000-0000-4000-8000-000000000201');

const hit = (moduleId: string, resourceType: string, title: string): ShellSearchResponse['results'][number] => ({
  kind: 'resource',
  ref: {
    moduleId: Schema.decodeUnknownSync(ModuleIdSchema)(moduleId),
    resourceId: Schema.decodeUnknownSync(ResourceIdSchema)(title),
    resourceType,
    tenantId,
  },
  selectedLegalEntityId: legalEntityId,
  title,
});

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

const compositionRevision = 'a'.repeat(64);
const presentationMetadata = (key: string, order: number, cs: string, en: string) => ({
  icon: 'icon-[mdi--file-outline]' as const,
  key,
  label: { cs, en },
  order,
});

const counterparty = hit('party.registry', 'party.registry.counterparty', 'Odběratel');
const task = hit('work.tasks', 'work.tasks.task', 'Úkol');

const presentationInventory = {
  business: {
    compositionRevision,
    entries: [
      {
        ownerModuleId: Schema.decodeUnknownSync(ModuleIdSchema)('party.registry'),
        presentation: {
          family: presentationMetadata('companies', 10, 'Firmy', 'Customers and suppliers'),
          group: presentationMetadata('counterparty', 10, 'Protiúčty', 'Customers and suppliers'),
          record: {
            pageKey: 'customers',
            selector: { idEncoding: 'native', idFormat: 'uuid', kind: 'path', parameterName: 'id' },
          },
          scope: 'company',
        },
        resourceType: 'party.registry.counterparty',
        searchKey: 'party.registry.search',
      },
      {
        ownerModuleId: Schema.decodeUnknownSync(ModuleIdSchema)('work.tasks'),
        presentation: {
          family: presentationMetadata('work', 20, 'Práce', 'Work'),
          group: presentationMetadata('task', 20, 'Úkoly', 'Tasks'),
          record: {
            pageKey: 'tasks',
            selector: { idEncoding: 'native', idFormat: 'opaque', kind: 'query', parameterName: 'resourceId' },
          },
          scope: 'company',
        },
        resourceType: 'work.tasks.task',
        searchKey: 'work.tasks.search',
      },
    ],
    schemaVersion: '1' as const,
  },
  pages: [
    {
      ownerModuleId: Schema.decodeUnknownSync(ModuleIdSchema)('party.registry'),
      pageKey: 'customers',
      routePath: '/prodej/zakaznici/:id',
    },
    {
      ownerModuleId: Schema.decodeUnknownSync(ModuleIdSchema)('work.tasks'),
      pageKey: 'tasks',
      routePath: '/ukoly',
    },
  ],
} satisfies ShellSearchPresentationInventory;
const searchIndex = shellSearchPresentationIndex(presentationInventory, compositionRevision);
if (searchIndex === undefined) {
  throw new Error('header fixture inventory must be current');
}

const unfiltered: ShellSearchResponse = {
  partial: false,
  presentation: presentationInventory,
  results: [counterparty, task],
};
const filtered: ShellSearchResponse = { partial: false, results: [counterparty] };
/** The inventory-only answer: the canonical release-bound inventory, no owner results. */
const inventoryOnly: ShellSearchResponse = {
  partial: false,
  presentation: presentationInventory,
  results: [],
};

const familyFixture = {
  family: {
    ...presentationMetadata('companies', 10, 'Firmy', 'Customers and suppliers'),
    groups: [],
    resourceTypes: ['party.registry.counterparty'],
  },
  key: 'companies',
};

const readySuggestions = ({
  availableFamilies = [familyFixture],
  groups = [],
  query = 'dvorak',
  selectedFamilies = [],
}: {
  readonly availableFamilies?: readonly ShellSearchFamilyAvailability[];
  readonly groups?: readonly ShellSearchSuggestionGroup[];
  readonly query?: string;
  readonly selectedFamilies?: readonly string[];
} = {}): ShellSearchSuggestionsState => ({
  filters: { availableFamilies, selectedFamilies },
  groups,
  index: searchIndex,
  partial: false,
  query,
  status: 'ready',
});

afterEach(cleanup);

const defaultSearch = (payload: ShellSearchPayload) => {
  if (payload.resourceTypes === undefined) {
    return Effect.succeed(unfiltered);
  }
  return Effect.succeed(payload.resourceTypes.length === 0 ? inventoryOnly : filtered);
};
const searchBff = (search: NonNullable<ShellBffScript['search']> = defaultSearch) => {
  const payloads: ShellSearchPayload[] = [];
  const bff = makeShellBff({
    search: (payload) => {
      payloads.push(payload);
      return search(payload);
    },
  });
  return { ...bff, payloads };
};
const searches = (bff: ReturnType<typeof searchBff>) => bff.payloads;

test.live('the header filter dispatches only the exact observed admitted types', () => {
  const bff = searchBff();
  return Effect.gen(function* headerFilterPayload() {
    const { result } = renderHook(() => useShellSearchSuggestions('a'.repeat(64), 'scope-1'), { wrapper: ShellCopy });

    act(() => {
      result.current.handleQueryChange('dvorak');
    });
    yield* waitUntil(() => result.current.state.status !== 'loading');
    expect(result.current.state.status).toBe('ready');
    if (result.current.state.status === 'ready') {
      expect(result.current.state.filters.availableFamilies.map(({ key }) => key)).toEqual(['companies', 'work']);
      expect(result.current.state.filters.selectedFamilies).toEqual([]);
    }
    yield* networkIdle;
    expect(searches(bff)[0]).toEqual({
      compositionRevision: 'a'.repeat(64),
      query: 'dvorak',
    });

    act(() => {
      result.current.handleFamiliesChange(['companies']);
    });
    yield* waitUntil(() => result.current.state.status !== 'loading');
    yield* networkIdle;
    expect(searches(bff).at(-1)).toEqual({
      compositionRevision: 'a'.repeat(64),
      query: 'dvorak',
      resourceTypes: ['party.registry.counterparty'],
    });
    expect(result.current.state.status).toBe('ready');
    if (result.current.state.status === 'ready') {
      expect(result.current.state.filters.selectedFamilies).toEqual(['companies']);
      expect(result.current.state.groups.map(({ presentation }) => presentation.key)).toEqual(['counterparty']);
    }
  }).pipe(Effect.provide(bff.browser));
});

test.live('a header family filter asks the inventory alone first and never an unfiltered request', () => {
  const bff = searchBff();
  return Effect.gen(function* headerFilterInventoryFirst() {
    const { result } = renderHook(() => useShellSearchSuggestions('a'.repeat(64), 'scope-1'), { wrapper: ShellCopy });
    act(() => result.current.handleQueryChange('dvorak'));
    yield* waitUntil(() => result.current.state.status !== 'loading');
    const callsBeforeFilter = searches(bff).length;

    act(() => result.current.handleFamiliesChange(['companies']));
    yield* waitUntil(() => result.current.state.status !== 'loading');
    yield* networkIdle;
    const filteredCalls = searches(bff).slice(callsBeforeFilter);
    // The first filtered request is the explicit empty inventory selector; the second is the exact selected type.
    expect(filteredCalls).toEqual([
      { compositionRevision: 'a'.repeat(64), query: 'dvorak', resourceTypes: [] },
      { compositionRevision: 'a'.repeat(64), query: 'dvorak', resourceTypes: ['party.registry.counterparty'] },
    ]);
    expect(filteredCalls.some(({ resourceTypes }) => resourceTypes === undefined)).toBe(false);
  }).pipe(Effect.provide(bff.browser));
});

test.live('an unknown header family shows nothing and never widens to the unfiltered answer', () => {
  const bff = searchBff();
  return Effect.gen(function* headerUnknownFamily() {
    const { result } = renderHook(() => useShellSearchSuggestions('a'.repeat(64), 'scope-1'), { wrapper: ShellCopy });
    act(() => result.current.handleQueryChange('dvorak'));
    yield* waitUntil(() => result.current.state.status !== 'loading');
    const callsBeforeFilter = searches(bff).length;

    act(() => result.current.handleFamiliesChange(['missing']));
    yield* waitUntil(() => result.current.state.status !== 'loading');
    yield* networkIdle;
    const filteredCalls = searches(bff).slice(callsBeforeFilter);
    expect(filteredCalls).toEqual([{ compositionRevision: 'a'.repeat(64), query: 'dvorak', resourceTypes: [] }]);
    expect(filteredCalls.some(({ resourceTypes }) => resourceTypes === undefined)).toBe(false);
    expect(result.current.state.status).toBe('ready');
    if (result.current.state.status === 'ready') {
      expect(result.current.state.groups).toEqual([]);
      // The canonical inventory survives, so the declared families stay selectable.
      expect(result.current.state.filters.availableFamilies.map(({ key }) => key)).toEqual(['companies', 'work']);
    }
  }).pipe(Effect.provide(bff.browser));
});

test.live('a query change resets the selected header filter and sends no stale types', () => {
  const bff = searchBff();
  return Effect.gen(function* headerQueryReset() {
    const { result } = renderHook(() => useShellSearchSuggestions('a'.repeat(64), 'scope-1'), { wrapper: ShellCopy });
    act(() => result.current.handleQueryChange('dvorak'));
    yield* waitUntil(() => result.current.state.status !== 'loading');
    act(() => result.current.handleFamiliesChange(['companies']));
    yield* waitUntil(() => result.current.state.status !== 'loading');

    act(() => result.current.handleQueryChange('jiný'));
    yield* waitUntil(() => result.current.state.status !== 'loading');
    expect(result.current.state.status).toBe('ready');
    if (result.current.state.status === 'ready') {
      expect(result.current.state.query).toBe('jiný');
      expect(result.current.state.filters.selectedFamilies).toEqual([]);
    }
    yield* networkIdle;
    expect(searches(bff).at(-1)).toEqual({
      compositionRevision: 'a'.repeat(64),
      query: 'jiný',
    });
  }).pipe(Effect.provide(bff.browser));
});

test.live('a company/tenant scope change rejects the old header response and clears filters', () =>
  Effect.gen(function* headerScopeRegression() {
    const deferred = yield* Deferred.make<ShellSearchResponse>();
    const answered = yield* Deferred.make<boolean>();
    const bff = searchBff(() => Deferred.await(deferred).pipe(Effect.tap(() => Deferred.succeed(answered, true))));
    yield* Effect.gen(function* scopeChange() {
      const { rerender, result } = renderHook(
        ({ scopeKey }: { readonly scopeKey: string }) => useShellSearchSuggestions('b'.repeat(64), scopeKey),
        { initialProps: { scopeKey: 'tenant-a/company-a' }, wrapper: ShellCopy },
      );

      act(() => result.current.handleQueryChange('dvorak'));
      yield* waitUntil(() => searches(bff).length === 1);
      expect(result.current.state.status).toBe('loading');

      rerender({ scopeKey: 'tenant-b/company-b' });
      expect(result.current.state.status).toBe('idle');
      yield* Deferred.succeed(deferred, unfiltered);
      // The stale answer was served and has reached the page before the page is checked.
      yield* Deferred.await(answered);
      yield* networkIdle;
      yield* settle;
      expect(result.current.state.status).toBe('idle');
    }).pipe(Effect.provide(bff.browser));
  }),
);

test.live('the header bar renders a family filter and reports the selection', () =>
  Effect.gen(function* headerView() {
    const selections: (readonly string[])[] = [];
    const onFamiliesChange = (families: readonly string[]) => {
      selections.push(families);
    };
    yield* renderBar(
      <ShellSearchBar
        onDismissSuggestions={noop}
        onFamiliesChange={onFamiliesChange}
        onSearch={noop}
        onValueChange={noop}
        SuggestionLink={() => null}
        suggestions={readySuggestions()}
        value="dvorak"
      />,
    );

    fireEvent.focus(screen.getByRole('searchbox', { name: 'Search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Customers and suppliers' }));
    expect(selections).toContainEqual(['companies']);
  }),
);

test.live('Escape on a header filter closes the panel and returns to the field', () =>
  Effect.gen(function* headerView() {
    const dismissals: true[] = [];
    const onDismissSuggestions = () => {
      dismissals.push(true);
    };
    yield* renderBar(
      <ShellSearchBar
        onDismissSuggestions={onDismissSuggestions}
        onFamiliesChange={noop}
        onSearch={noop}
        onValueChange={noop}
        SuggestionLink={() => null}
        suggestions={readySuggestions()}
        value="dvorak"
      />,
    );

    fireEvent.focus(screen.getByRole('searchbox', { name: 'Search' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Customers and suppliers' }), { key: 'Escape' });
    expect(dismissals.length).toBeGreaterThan(0);
  }),
);

test.live('missing trusted principal refuses header search', () => {
  const bff = searchBff();
  return Effect.gen(function* missingPrincipal() {
    const missingScope: string | undefined = ['principal'][1];
    const { result } = renderHook(() => useShellSearchSuggestions('a'.repeat(64), missingScope), {
      wrapper: ShellCopy,
    });
    act(() => {
      result.current.handleQueryChange('dvorak');
    });
    yield* networkIdle;
    yield* settle;
    expect(result.current.state.status).toBe('idle');
    yield* networkIdle;
    expect(searches(bff)).toEqual([]);
  }).pipe(Effect.provide(bff.browser));
});

test.live('a person whose Roles exclude search is told so once, and typing asks nothing more', () => {
  const bff = searchBff(() =>
    Effect.fail(
      ShellTargetForbiddenProblemSchema.make({
        detail: 'Search is not granted in this scope.',
        status: 403,
        title: 'Forbidden',
        type: 'about:blank',
      }),
    ),
  );
  return Effect.gen(function* searchNotGranted() {
    const { result } = renderHook(() => useShellSearchSuggestions('a'.repeat(64), 'scope-1'), { wrapper: ShellCopy });
    act(() => result.current.handleQueryChange('dvorak'));
    yield* waitUntil(() => result.current.state.status !== 'loading');
    expect(result.current.state.status).toBe('forbidden');
    act(() => result.current.handleQueryChange('dvorakova'));
    yield* networkIdle;
    yield* settle;
    expect({ calls: searches(bff).length, status: result.current.state.status }).toEqual({
      calls: 1,
      status: 'forbidden',
    });
  }).pipe(Effect.provide(bff.browser));
});

test.live('the header bar says plainly that search is not granted, not that it is unavailable', () =>
  Effect.gen(function* headerView() {
    yield* renderBar(
      <ShellSearchBar
        onDismissSuggestions={noop}
        onFamiliesChange={noop}
        onSearch={noop}
        onValueChange={noop}
        SuggestionLink={() => null}
        suggestions={{ filters: { availableFamilies: [], selectedFamilies: [] }, query: 'dvorak', status: 'forbidden' }}
        value="dvorak"
      />,
    );
    fireEvent.focus(screen.getByRole('searchbox', { name: 'Search' }));
    expect(screen.getByText("Search isn't part of your access. Ask your administrator for it.")).toBeTruthy();
    expect(screen.queryByText('Search is temporarily unavailable. Try again.')).toBeNull();
  }),
);

test.live('a header suggestion shows the matched variant name/SKU under the parent product title', () =>
  Effect.gen(function* headerView() {
    const result = variantProductHit();
    const groups: readonly ShellSearchSuggestionGroup[] = [
      {
        presentation: {
          ...presentationMetadata('product', 10, 'Produkty', 'Products'),
          resourceTypes: ['demo.merchandise.product'],
        },
        suggestions: [
          {
            archived: false,
            key: 'demo.merchandise:demo.merchandise.product:product-1',
            result,
            roles: [],
            target: shellSearchResultTarget(result, searchIndex),
            title: result.title,
          },
        ],
        total: 1,
      },
    ];
    yield* renderBar(
      <ShellSearchBar
        onDismissSuggestions={noop}
        onFamiliesChange={noop}
        onSearch={noop}
        onValueChange={noop}
        SuggestionLink={({ children }) => <Link to="/product-parent">{children}</Link>}
        suggestions={readySuggestions({ groups, query: 'adapt' })}
        value="adapt"
      />,
    );

    fireEvent.focus(screen.getByRole('searchbox', { name: 'Search' }));
    const link = screen.getByRole('link', { name: /Product parent/u });
    expect(link.textContent).toContain('Adaptér 18 mm');
    expect(link.textContent).toContain('18kop009');
  }),
);

test.live('header shows the approved generic subtitle and archive badge in its one context line', () =>
  Effect.gen(function* headerView() {
    const base = {
      ...hit('projects.core', 'projects.project', 'Projekt Praha'),
      matchedVariant: { id: 'variant-9', name: 'Adaptér 18 mm', sku: '18kop009' },
    };
    const archived = { ...base, archived: true, subtitle: 'PRJ-2026-14' };
    const plain = { ...hit('inventory.stock', 'inventory.stock.item', 'Bez archivu'), archived: false };
    const groups: readonly ShellSearchSuggestionGroup[] = [
      {
        presentation: {
          ...presentationMetadata('project', 10, 'Projekty', 'Projects'),
          resourceTypes: ['projects.project'],
        },
        suggestions: [
          {
            archived: true,
            key: 'projects.core:projects.project:project-1',
            result: archived,
            roles: [],
            target: shellSearchResultTarget(archived, searchIndex),
            title: archived.title,
          },
          {
            archived: false,
            key: 'inventory.stock:inventory.stock.item:item-1',
            result: plain,
            roles: [],
            target: shellSearchResultTarget(plain, searchIndex),
            title: plain.title,
          },
        ],
        total: 2,
      },
    ];
    yield* renderBar(
      <ShellSearchBar
        onDismissSuggestions={noop}
        onFamiliesChange={noop}
        onSearch={noop}
        onValueChange={noop}
        SuggestionLink={({ 'aria-label': ariaLabel, children }) => (
          <Link aria-label={ariaLabel} to="/suggestion">
            {children}
          </Link>
        )}
        suggestions={readySuggestions({ groups, query: 'praha' })}
        value="praha"
      />,
    );

    fireEvent.focus(screen.getByRole('searchbox', { name: 'Search' }));
    const link = screen.getByRole('link', { name: /Projekt Praha.*PRJ-2026-14.*Adaptér 18 mm.*18kop009.*Archived/u });
    // The accessible name keeps the whole highlighted word and every visible approved detail.
    expect(link.getAttribute('aria-label')).toContain('Projekt Praha');
    expect(link.getAttribute('aria-label')).toContain('PRJ-2026-14');
    expect(link.getAttribute('aria-label')).toContain('Adaptér 18 mm');
    expect(link.getAttribute('aria-label')).toContain('18kop009');
    expect(link.textContent?.match(/PRJ-2026-14/gu)).toHaveLength(1);
    expect(screen.getByText('Archived')).toBeTruthy();

    const plainLink = screen.getByRole('link', { name: /Bez archivu/u });
    expect(plainLink.getAttribute('aria-label')).not.toContain('Archived');
  }),
);
