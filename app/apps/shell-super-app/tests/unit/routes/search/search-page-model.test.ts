import type { CoreSearchPresentationEntry } from '@app/core-runtime/search-contract';
import { Effect, Schema } from 'effect';
import { expect, it, rstest, test } from 'effect-rstest';

import {
  ModuleIdSchema,
  ResourceIdSchema,
  ShellTargetForbiddenProblemSchema,
  TenantIdSchema,
} from '../../../../shared/browser-api.ts';
import type {
  ShellSearchPayload,
  ShellSearchPresentationInventory,
  ShellSearchResponse,
  ShellSearchResult,
} from '../../../../shared/browser-api.ts';
import {
  loader,
  searchFailureModel,
  searchFamiliesFromValue,
  searchReadyModel,
} from '../../../../src/routes/[lang]/search/search-page-model.ts';
import type { ShellAuthenticationClientOptions, ShellSearchClientError } from '../../../../src/api/auth-client.ts';
import { planShellSearchFilters } from '../../../../src/routes/shell-search-match.ts';
import { shellSearchPresentationIndex } from '../../../../src/routes/shell-search-resource-types.ts';
import type { ShellSearchPresentationIndex } from '../../../../src/routes/shell-search-resource-types.ts';
import { authenticatedShellFixture } from '../authenticated-shell-fixture.ts';
import { shellAuthenticationClientOptionsFromRequest } from '../../../../src/routes/shell-authentication-client-options.ts' with {
  rstest: 'importActual',
};

const { searchResourcesMock } = rstest.hoisted(() => ({
  searchResourcesMock:
    rstest.fn<
      (
        payload: ShellSearchPayload,
        options?: ShellAuthenticationClientOptions,
      ) => Effect.Effect<ShellSearchResponse, ShellSearchClientError>
    >(),
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({ searchResources: searchResourcesMock }));

const { loadShellMock, serverRenderState } = rstest.hoisted(() => ({
  loadShellMock: rstest.fn(),
  serverRenderState: { current: false },
}));

rstest.mock('../../../../src/routes/[lang]/home-page-model.ts', () => ({ loadHomePageModel: loadShellMock }));
rstest.mock('../../../../src/routes/shell-authentication-client-options.ts', () => ({
  isServerRender: () => serverRenderState.current,
  shellAuthenticationClientOptionsFromRequest,
}));

const compositionRevision = 'a'.repeat(64);
const metadata = (key: string, order: number) => ({
  icon: 'icon-[mdi--file-outline]' as const,
  key,
  label: { cs: key, en: key },
  order,
});

const entry = (
  ownerModuleId: string,
  resourceType: string,
  family: string,
  familyOrder: number,
  group: string,
  groupOrder: number,
): CoreSearchPresentationEntry => ({
  ownerModuleId,
  presentation: {
    family: metadata(family, familyOrder),
    group: metadata(group, groupOrder),
    scope: 'company',
  },
  resourceType,
  searchKey: `${ownerModuleId}.search`,
});

const declaredEntries = (): readonly CoreSearchPresentationEntry[] => [
  entry('party.registry', 'party.registry.counterparty', 'companies', 10, 'counterparty', 20),
  entry('demo.crm', 'demo.crm.client', 'companies', 10, 'client', 10),
  entry('work.tasks', 'work.tasks.task', 'work', 20, 'task', 20),
];

const inventoryFor = (entries: readonly CoreSearchPresentationEntry[]): ShellSearchPresentationInventory => ({
  business: { compositionRevision, entries, schemaVersion: '1' },
  pages: [],
});

const presentationInventory = (): ShellSearchPresentationInventory => inventoryFor(declaredEntries());

const inventory = (): ShellSearchPresentationIndex => {
  const index = shellSearchPresentationIndex(presentationInventory(), compositionRevision);
  if (index === undefined) {
    throw new Error('expected a validated inventory');
  }
  return index;
};

test('a search the Roles do not grant says so plainly, not that search is unavailable', () => {
  const forbidden = Schema.decodeUnknownSync(ShellTargetForbiddenProblemSchema)({
    _tag: 'ShellTargetForbiddenProblem',
    detail: 'The principal cannot search here.',
    status: 403,
    title: 'Shell target forbidden',
    type: 'https://ontos.dev/problems/shell-target-forbidden',
  });
  expect(searchFailureModel(forbidden, authenticatedShellFixture(), 'dvorak').state).toBe('notGranted');
});

test('no selected family omits resourceTypes and lists the declared families in owner order', () => {
  const plan = planShellSearchFilters({ index: inventory(), partial: false, requestedFamilies: [] });
  expect(plan.selectedFamilies).toEqual([]);
  expect(plan.resourceTypes).toBeUndefined();
  expect(plan.availableFamilies.map(({ key }) => key)).toEqual(['companies', 'work']);
  expect(plan.availableFamilies[0]?.family.groups.map(({ key }) => key)).toEqual(['client', 'counterparty']);
});

test('a selected family sends only the exact resource types its inventory declares', () => {
  expect(
    planShellSearchFilters({ index: inventory(), partial: false, requestedFamilies: ['companies'] }).resourceTypes,
  ).toEqual(['demo.crm.client', 'party.registry.counterparty']);
  expect(
    planShellSearchFilters({ index: inventory(), partial: false, requestedFamilies: ['work', 'companies'] })
      .resourceTypes,
  ).toEqual(['demo.crm.client', 'party.registry.counterparty', 'work.tasks.task']);
});

test('an unknown family never widens the payload to an unfiltered answer', () => {
  expect(planShellSearchFilters({ index: inventory(), partial: false, requestedFamilies: ['missing'] })).toMatchObject({
    resourceTypes: [],
    selectedFamilies: [],
  });
  expect(
    planShellSearchFilters({ index: inventory(), partial: false, requestedFamilies: ['work', 'missing'] }),
  ).toMatchObject({ resourceTypes: [], selectedFamilies: ['work'] });
});

test('a partial answer offers no filter and never guesses a payload', () => {
  expect(planShellSearchFilters({ index: inventory(), partial: true, requestedFamilies: ['work'] })).toEqual({
    availableFamilies: [],
    selectedFamilies: [],
  });
});

test('the URL carries bounded family keys only; a malformed key stays an unresolved selection', () => {
  expect(searchFamiliesFromValue()).toEqual([]);
  expect(searchFamiliesFromValue('')).toEqual([]);
  expect(searchFamiliesFromValue('companies, work')).toEqual(['companies', 'work']);
  expect(searchFamiliesFromValue(' companies , work ')).toEqual(['companies', 'work']);
  expect(searchFamiliesFromValue('missing')).toEqual(['missing']);
  // A present but malformed key is kept, so an invalid nonempty filter never silently becomes unfiltered.
  expect(searchFamiliesFromValue('Invalid Key')).toEqual(['Invalid Key']);
  expect(searchFamiliesFromValue('work,Invalid Key')).toEqual(['work', 'Invalid Key']);
});

/**
 * Request-sequence evidence for the full-results model. The mock records every `searchResources` payload, so a test
 * proves exactly which owner reads a flow issues and in which order. No test guesses an owner type: the narrowed
 * payload is always the inventory's own declared type list, and a filtered flow never issues an unfiltered request.
 */
const searchResponse = (
  results: ShellSearchResponse['results'] = [],
  presentation: ShellSearchPresentationInventory = presentationInventory(),
): ShellSearchResponse => ({ partial: false, presentation, results });

const resourceHit = (title: string): ShellSearchResult => ({
  kind: 'resource',
  ref: {
    moduleId: Schema.decodeUnknownSync(ModuleIdSchema)('demo.crm'),
    resourceId: Schema.decodeUnknownSync(ResourceIdSchema)('client-1'),
    resourceType: 'demo.crm.client',
    tenantId: Schema.decodeUnknownSync(TenantIdSchema)('00000000-0000-4000-8000-000000000101'),
  },
  title,
});

const recordedPayloads = (): readonly ShellSearchPayload[] =>
  searchResourcesMock.mock.calls.map(([payload]) => payload);

const unfilteredHit = () => searchResponse([resourceHit('Unfiltered hit')]);
const inventoryAnswer = () => searchResponse([]);
const selectedOnlyInventory = () =>
  inventoryFor(declaredEntries().filter(({ resourceType }) => resourceType.startsWith('demo.crm')));
const canonicalResourceTypes = ['party.registry.counterparty', 'demo.crm.client', 'work.tasks.task'];

/** One recorded-request answer: an unfiltered read, an inventory-only read, or the selected types. */
const answerFor = (payload: ShellSearchPayload): ShellSearchResponse => {
  if (payload.resourceTypes === undefined) {
    return unfilteredHit();
  }
  if (payload.resourceTypes.length === 0) {
    return inventoryAnswer();
  }
  return searchResponse([resourceHit('Filtered hit')], selectedOnlyInventory());
};

const runReadySearch = (requestedFamilies: readonly string[]) =>
  searchReadyModel({
    compositionRevision,
    options: {},
    query: 'novák',
    requestedFamilies,
    shell: authenticatedShellFixture(),
  }).pipe(
    Effect.flatMap((model) =>
      model.state === 'ready'
        ? Effect.succeed(model)
        : Effect.die(new Error(`expected a ready search model, received ${model.state}`)),
    ),
  );

it.effect('an unfiltered full-results search issues exactly one real owner request', () =>
  Effect.gen(function* unfilteredSearch() {
    searchResourcesMock.mockReset();
    searchResourcesMock.mockImplementation(() => Effect.succeed(unfilteredHit()));
    const model = yield* runReadySearch([]);
    expect(recordedPayloads()).toEqual([{ compositionRevision, query: 'novák' }]);
    expect(model.filters.resourceTypes).toBeUndefined();
    expect(model.filters.availableFamilies.map(({ key }) => key)).toEqual(['companies', 'work']);
    expect(model.response.results.map(({ title }) => title)).toEqual(['Unfiltered hit']);
    expect(model.index?.business.map(({ resourceType }) => resourceType)).toEqual(canonicalResourceTypes);
  }),
);

it.effect('a filtered full-results search asks the inventory alone first and then only the selected types', () =>
  Effect.gen(function* filteredSearch() {
    searchResourcesMock.mockReset();
    searchResourcesMock.mockImplementation((payload: ShellSearchPayload) => Effect.succeed(answerFor(payload)));
    const model = yield* runReadySearch(['companies']);
    // The inventory-only request first, the exact selected types second, and never an unfiltered request.
    expect(recordedPayloads()).toEqual([
      { compositionRevision, query: 'novák', resourceTypes: [] },
      { compositionRevision, query: 'novák', resourceTypes: ['demo.crm.client', 'party.registry.counterparty'] },
    ]);
    expect(recordedPayloads().some(({ resourceTypes }) => resourceTypes === undefined)).toBe(false);
    expect(model.filters.selectedFamilies).toEqual(['companies']);
    expect(model.filters.resourceTypes).toEqual(['demo.crm.client', 'party.registry.counterparty']);
    expect(model.response.results.map(({ title }) => title)).toEqual(['Filtered hit']);
    // The selected-only answer never shrinks the filter row: the canonical inventory index survives.
    expect(model.filters.availableFamilies.map(({ key }) => key)).toEqual(['companies', 'work']);
    expect(model.index?.business.map(({ resourceType }) => resourceType)).toEqual(canonicalResourceTypes);
  }),
);

it.effect('an unknown-only family asks the inventory alone and never exposes unfiltered results', () =>
  Effect.gen(function* unknownFamilySearch() {
    searchResourcesMock.mockReset();
    searchResourcesMock.mockImplementation((payload: ShellSearchPayload) =>
      Effect.succeed(payload.resourceTypes === undefined ? unfilteredHit() : inventoryAnswer()),
    );
    const model = yield* runReadySearch(['missing']);
    expect(recordedPayloads()).toEqual([{ compositionRevision, query: 'novák', resourceTypes: [] }]);
    expect(model.filters).toMatchObject({ resourceTypes: [], selectedFamilies: [] });
    expect(model.filters.availableFamilies.map(({ key }) => key)).toEqual(['companies', 'work']);
    expect(model.response.results).toEqual([]);
    expect(model.response.presentation).toBeDefined();
    expect(model.index).toBeDefined();
  }),
);

it.effect('a known family mixed with an unknown one asks the inventory alone and shows nothing', () =>
  Effect.gen(function* mixedFamilySearch() {
    searchResourcesMock.mockReset();
    searchResourcesMock.mockImplementation((payload: ShellSearchPayload) =>
      Effect.succeed(payload.resourceTypes === undefined ? unfilteredHit() : inventoryAnswer()),
    );
    const model = yield* runReadySearch(['work', 'missing']);
    expect(recordedPayloads()).toEqual([{ compositionRevision, query: 'novák', resourceTypes: [] }]);
    expect(model.filters).toMatchObject({ resourceTypes: [], selectedFamilies: ['work'] });
    expect(model.response.results).toEqual([]);
    expect(model.filters.availableFamilies.map(({ key }) => key)).toEqual(['companies', 'work']);
  }),
);

it.effect('a malformed family filter asks the inventory alone and never widens to the unfiltered answer', () =>
  Effect.gen(function* malformedFamilySearch() {
    searchResourcesMock.mockReset();
    searchResourcesMock.mockImplementation((payload: ShellSearchPayload) =>
      Effect.succeed(payload.resourceTypes === undefined ? unfilteredHit() : inventoryAnswer()),
    );
    const model = yield* runReadySearch(searchFamiliesFromValue('Invalid Key'));
    expect(recordedPayloads()).toEqual([{ compositionRevision, query: 'novák', resourceTypes: [] }]);
    expect(model.response.results).toEqual([]);
    expect(model.filters.availableFamilies.map(({ key }) => key)).toEqual(['companies', 'work']);
  }),
);

it.effect('a partial inventory answer issues one request and offers no filter', () =>
  Effect.gen(function* partialSearch() {
    searchResourcesMock.mockReset();
    searchResourcesMock.mockImplementation(() =>
      Effect.succeed({ partial: true, presentation: presentationInventory(), results: [] }),
    );
    const model = yield* runReadySearch(['companies']);
    expect(recordedPayloads()).toEqual([{ compositionRevision, query: 'novák', resourceTypes: [] }]);
    expect(model.filters).toEqual({ availableFamilies: [], selectedFamilies: [] });
    expect(model.response.partial).toBe(true);
  }),
);

const searchUrl = 'https://ontos.test/en/search?q=Morava';

it.effect('a server render returns the shell with the query pending and never runs the search', () =>
  Effect.gen(function* serverRenderSearch() {
    searchResourcesMock.mockReset();
    searchResourcesMock.mockImplementation(() => Effect.succeed(unfilteredHit()));
    loadShellMock.mockReturnValue(Effect.succeed(authenticatedShellFixture()));
    serverRenderState.current = true;
    const model = yield* Effect.promise(() => loader({ request: new Request(searchUrl) })).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          serverRenderState.current = false;
        }),
      ),
    );
    expect(searchResourcesMock).not.toHaveBeenCalled();
    expect(model).toMatchObject({ query: 'Morava', state: 'pending' });
    expect(model.shell.state).toBe('authenticated');
  }),
);

it.effect('the browser loader still returns the answered search', () =>
  Effect.gen(function* browserSearch() {
    searchResourcesMock.mockReset();
    searchResourcesMock.mockImplementation(() => Effect.succeed(unfilteredHit()));
    const shell = authenticatedShellFixture();
    loadShellMock.mockReturnValue(Effect.succeed(shell));
    serverRenderState.current = false;
    const model = yield* Effect.promise(() => loader({ request: new Request(searchUrl) }));
    expect(recordedPayloads()).toEqual([{ compositionRevision: shell.compositionRevision, query: 'Morava' }]);
    expect(model).toMatchObject({ query: 'Morava', state: 'ready' });
    expect(model.state === 'ready' ? model.response.results.map(({ title }) => title) : []).toEqual(['Unfiltered hit']);
  }),
);
