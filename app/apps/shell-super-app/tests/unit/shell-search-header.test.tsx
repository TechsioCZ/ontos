import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it as test, rstest } from 'effect-rstest';

import type {
  ShellSearchPayload,
  ShellSearchPresentationInventory,
  ShellSearchResponse,
  ShellSearchResult,
} from '../../shared/api.ts';
import { LegalEntityIdSchema, ModuleIdSchema, ResourceIdSchema, TenantIdSchema } from '../../shared/api.ts';
import { ShellSearchBar } from '../../src/routes/shell-search-bar.tsx';
import { shellSearchPresentationIndex, shellSearchResultTarget } from '../../src/routes/shell-search-resource-types.ts';
import type { ShellSearchFamilyAvailability } from '../../src/routes/shell-search-match.ts';
import { useShellSearchSuggestions } from '../../src/routes/shell-search-suggestions.ts';
import type {
  ShellSearchSuggestionGroup,
  ShellSearchSuggestionsState,
} from '../../src/routes/shell-search-suggestions.ts';

const noop = (): void => {};

const { languageState, searchResourcesMock } = rstest.hoisted(() => ({
  languageState: { current: 'en' },
  searchResourcesMock: rstest.fn(),
}));

const translations = new Map(
  Object.entries({
    'shell.search.archived': 'Archived',
    'shell.search.clear': 'Clear search',
    'shell.search.groups.counterparty': 'Customers and suppliers',
    'shell.search.groups.product': 'Products',
    'shell.search.groups.task': 'Tasks',
    'shell.search.label': 'Search',
    'shell.search.partial': 'Some providers are unavailable.',
    'shell.search.placeholder': 'Search clients, tasks, invoices, contracts…',
    'shell.search.suggestions.all': 'Show all results for “{{query}}”',
    'shell.search.suggestions.empty': 'Nothing found for “{{query}}”.',
    'shell.search.suggestions.label': 'Search suggestions',
    'shell.search.suggestions.loading': 'Searching…',
    'shell.search.unavailable': 'Search is temporarily unavailable. Try again.',
  }),
);

const translate = (key: string, values?: Readonly<Record<string, string>>): string => {
  let sentence = translations.get(key) ?? key;
  for (const [name, value] of Object.entries(values ?? {})) {
    sentence = sentence.replaceAll(`{{${name}}}`, value);
  }
  return sentence;
};

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: languageState.current, t: translate }),
}));

rstest.mock('../../src/api/auth-client.ts', () => ({
  searchResources: searchResourcesMock,
}));

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

beforeEach(() => {
  languageState.current = 'en';
  rstest.useFakeTimers();
  searchResourcesMock.mockImplementation((payload: ShellSearchPayload) => {
    if (payload.resourceTypes === undefined) {
      return Effect.succeed(unfiltered);
    }
    return Effect.succeed(payload.resourceTypes.length === 0 ? inventoryOnly : filtered);
  });
});

afterEach(() => {
  cleanup();
  rstest.useRealTimers();
  languageState.current = 'en';
  rstest.clearAllMocks();
});

const settle = () =>
  Effect.promise(() =>
    act(async () => {
      await rstest.advanceTimersByTimeAsync(200);
    }),
  );

test.effect('the header filter dispatches only the exact observed admitted types', () =>
  Effect.gen(function* headerFilterPayload() {
    const { result } = renderHook(() => useShellSearchSuggestions('a'.repeat(64), 'scope-1'));

    act(() => {
      result.current.handleQueryChange('dvorak');
    });
    yield* settle();
    expect(result.current.state.status).toBe('ready');
    if (result.current.state.status === 'ready') {
      expect(result.current.state.filters.availableFamilies.map(({ key }) => key)).toEqual(['companies', 'work']);
      expect(result.current.state.filters.selectedFamilies).toEqual([]);
    }
    expect(searchResourcesMock.mock.calls[0]?.[0]).toEqual({
      compositionRevision: 'a'.repeat(64),
      query: 'dvorak',
    });

    act(() => {
      result.current.handleFamiliesChange(['companies']);
    });
    yield* settle();
    expect(searchResourcesMock.mock.calls.at(-1)?.[0]).toEqual({
      compositionRevision: 'a'.repeat(64),
      query: 'dvorak',
      resourceTypes: ['party.registry.counterparty'],
    });
    expect(result.current.state.status).toBe('ready');
    if (result.current.state.status === 'ready') {
      expect(result.current.state.filters.selectedFamilies).toEqual(['companies']);
      expect(result.current.state.groups.map(({ presentation }) => presentation.key)).toEqual(['counterparty']);
    }
  }),
);

test.effect('a header family filter asks the inventory alone first and never an unfiltered request', () =>
  Effect.gen(function* headerFilterInventoryFirst() {
    const { result } = renderHook(() => useShellSearchSuggestions('a'.repeat(64), 'scope-1'));
    act(() => result.current.handleQueryChange('dvorak'));
    yield* settle();
    const callsBeforeFilter = searchResourcesMock.mock.calls.length;

    act(() => result.current.handleFamiliesChange(['companies']));
    yield* settle();
    const filteredCalls = searchResourcesMock.mock.calls.slice(callsBeforeFilter).map(([payload]) => payload);
    // The first filtered request is the explicit empty inventory selector; the second is the exact selected type.
    expect(filteredCalls).toEqual([
      { compositionRevision: 'a'.repeat(64), query: 'dvorak', resourceTypes: [] },
      { compositionRevision: 'a'.repeat(64), query: 'dvorak', resourceTypes: ['party.registry.counterparty'] },
    ]);
    expect(filteredCalls.some(({ resourceTypes }) => resourceTypes === undefined)).toBe(false);
  }),
);

test.effect('an unknown header family shows nothing and never widens to the unfiltered answer', () =>
  Effect.gen(function* headerUnknownFamily() {
    const { result } = renderHook(() => useShellSearchSuggestions('a'.repeat(64), 'scope-1'));
    act(() => result.current.handleQueryChange('dvorak'));
    yield* settle();
    const callsBeforeFilter = searchResourcesMock.mock.calls.length;

    act(() => result.current.handleFamiliesChange(['missing']));
    yield* settle();
    const filteredCalls = searchResourcesMock.mock.calls.slice(callsBeforeFilter).map(([payload]) => payload);
    expect(filteredCalls).toEqual([{ compositionRevision: 'a'.repeat(64), query: 'dvorak', resourceTypes: [] }]);
    expect(filteredCalls.some(({ resourceTypes }) => resourceTypes === undefined)).toBe(false);
    expect(result.current.state.status).toBe('ready');
    if (result.current.state.status === 'ready') {
      expect(result.current.state.groups).toEqual([]);
      // The canonical inventory survives, so the declared families stay selectable.
      expect(result.current.state.filters.availableFamilies.map(({ key }) => key)).toEqual(['companies', 'work']);
    }
  }),
);

test.effect('a query change resets the selected header filter and sends no stale types', () =>
  Effect.gen(function* headerQueryReset() {
    const { result } = renderHook(() => useShellSearchSuggestions('a'.repeat(64), 'scope-1'));
    act(() => result.current.handleQueryChange('dvorak'));
    yield* settle();
    act(() => result.current.handleFamiliesChange(['companies']));
    yield* settle();

    act(() => result.current.handleQueryChange('jiný'));
    yield* settle();
    expect(result.current.state.status).toBe('ready');
    if (result.current.state.status === 'ready') {
      expect(result.current.state.query).toBe('jiný');
      expect(result.current.state.filters.selectedFamilies).toEqual([]);
    }
    expect(searchResourcesMock.mock.calls.at(-1)?.[0]).toEqual({
      compositionRevision: 'a'.repeat(64),
      query: 'jiný',
    });
  }),
);

test.effect('a company/tenant scope change rejects the old header response and clears filters', () =>
  Effect.gen(function* headerScopeRegression() {
    const deferred = yield* Deferred.make<ShellSearchResponse>();
    searchResourcesMock.mockReturnValue(Deferred.await(deferred));
    const { rerender, result } = renderHook(
      ({ scopeKey }: { readonly scopeKey: string }) => useShellSearchSuggestions('b'.repeat(64), scopeKey),
      { initialProps: { scopeKey: 'tenant-a/company-a' } },
    );

    act(() => result.current.handleQueryChange('dvorak'));
    yield* settle();
    expect(result.current.state.status).toBe('loading');

    rerender({ scopeKey: 'tenant-b/company-b' });
    expect(result.current.state.status).toBe('idle');
    yield* Deferred.succeed(deferred, unfiltered);
    yield* Effect.promise(() =>
      act(async () => {
        await rstest.advanceTimersByTimeAsync(0);
      }),
    );
    expect(result.current.state.status).toBe('idle');
  }),
);

test('the header bar renders a family filter and reports the selection', () => {
  const onFamiliesChange = rstest.fn<(families: readonly string[]) => void>();
  render(
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
  expect(onFamiliesChange).toHaveBeenCalledWith(['companies']);
});

test('Escape on a header filter closes the panel and returns to the field', () => {
  const onDismissSuggestions = rstest.fn<() => void>();
  render(
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
  expect(onDismissSuggestions).toHaveBeenCalled();
});

test.effect('missing trusted principal refuses header search', () =>
  Effect.gen(function* missingPrincipal() {
    const missingScope: string | undefined = ['principal'][1];
    const { result } = renderHook(() => useShellSearchSuggestions('a'.repeat(64), missingScope));
    act(() => {
      result.current.handleQueryChange('dvorak');
    });
    yield* settle();
    expect(result.current.state.status).toBe('idle');
    expect(searchResourcesMock).not.toHaveBeenCalled();
  }),
);

test('a header suggestion shows the matched variant name/SKU under the parent product title', () => {
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
  render(
    <ShellSearchBar
      onDismissSuggestions={noop}
      onFamiliesChange={noop}
      onSearch={noop}
      onValueChange={noop}
      SuggestionLink={({ children }) => <a href="/product-parent">{children}</a>}
      suggestions={readySuggestions({ groups, query: 'adapt' })}
      value="adapt"
    />,
  );

  fireEvent.focus(screen.getByRole('searchbox', { name: 'Search' }));
  const link = screen.getByRole('link', { name: /Product parent/u });
  expect(link.textContent).toContain('Adaptér 18 mm');
  expect(link.textContent).toContain('18kop009');
});

test('header shows the approved generic subtitle and archive badge in its one context line', () => {
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
  render(
    <ShellSearchBar
      onDismissSuggestions={noop}
      onFamiliesChange={noop}
      onSearch={noop}
      onValueChange={noop}
      SuggestionLink={({ 'aria-label': ariaLabel, children }) => (
        <a aria-label={ariaLabel} href="/suggestion">
          {children}
        </a>
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
});
