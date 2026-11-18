// @rstest-environment happy-dom
import type { CoreSearchPresentationEntry } from '@app/core-runtime/search-contract';
import { Effect, Schema } from 'effect';
import { expect, it, test } from 'effect-rstest';

import {
  AvailableLegalEntitiesResponseSchema,
  LegalEntityIdSchema,
  ModuleIdSchema,
  ResourceIdSchema,
  ShellDocumentContextSchema,
  ShellTargetForbiddenProblemSchema,
  TenantIdSchema,
} from '../../../../shared/browser-api.ts';
import type {
  ShellSearchPayload,
  ShellSearchPresentationInventory,
  ShellSearchResponse,
  ShellSearchResult,
} from '../../../../shared/browser-api.ts';
import { resetBrowserSessionCache } from '../../../../src/routes/[lang]/home-page-model.ts';
import {
  loader,
  searchFailureModel,
  searchFamiliesFromValue,
  searchReadyModel,
} from '../../../../src/routes/[lang]/search/search-page-model.ts';
import { planShellSearchFilters } from '../../../../src/routes/shell-search-match.ts';
import { shellSearchPresentationIndex } from '../../../../src/routes/shell-search-resource-types.ts';
import type { ShellSearchPresentationIndex } from '../../../../src/routes/shell-search-resource-types.ts';
import {
  adaSignedIn,
  makeShellBff,
  shellCompositionRevision,
  signedInShellReads,
} from '../../../support/shell-bff-double.ts';
import type { ShellBffScript } from '../../../support/shell-bff-double.ts';
import { authenticatedShellFixture } from '../authenticated-shell-fixture.ts';

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
 * Request-sequence evidence for the full-results model. The Shell BFF double records every search payload the real
 * client sends, so a test proves exactly which owner reads a flow issues and in which order. No test guesses an owner type: the narrowed
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
  // A company-scoped hit names the company it was found in, as the declared `company` scope requires.
  selectedLegalEntityId: Schema.decodeUnknownSync(LegalEntityIdSchema)('20000000-0000-4000-8000-000000000001'),
  title,
});

/** A BFF whose search answers each payload with `answer` and records the payloads it received, in order. */
const searchBff = (answer: (payload: ShellSearchPayload) => ShellSearchResponse, script: ShellBffScript = {}) => {
  const payloads: ShellSearchPayload[] = [];
  const bff = makeShellBff({
    ...script,
    search: (payload) =>
      Effect.sync(() => {
        payloads.push(payload);
        return answer(payload);
      }),
  });
  return { ...bff, payloads };
};
type Bff = ReturnType<typeof searchBff>;
/** The search payloads the BFF received, in order. */
const recordedPayloads = (bff: Bff): readonly ShellSearchPayload[] => bff.payloads;
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

const runReadySearch = (bff: Bff, requestedFamilies: readonly string[]) =>
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
    Effect.provide(bff.layer),
  );

it.effect('an unfiltered full-results search issues exactly one real owner request', () =>
  Effect.gen(function* unfilteredSearch() {
    const bff = searchBff(unfilteredHit);
    const model = yield* runReadySearch(bff, []);
    expect(recordedPayloads(bff)).toEqual([{ compositionRevision, query: 'novák' }]);
    expect(model.filters.resourceTypes).toBeUndefined();
    expect(model.filters.availableFamilies.map(({ key }) => key)).toEqual(['companies', 'work']);
    expect(model.response.results.map(({ title }) => title)).toEqual(['Unfiltered hit']);
    expect(model.index?.business.map(({ resourceType }) => resourceType)).toEqual(canonicalResourceTypes);
  }),
);

it.effect('a filtered full-results search asks the inventory alone first and then only the selected types', () =>
  Effect.gen(function* filteredSearch() {
    const bff = searchBff(answerFor);
    const model = yield* runReadySearch(bff, ['companies']);
    // The inventory-only request first, the exact selected types second, and never an unfiltered request.
    expect(recordedPayloads(bff)).toEqual([
      { compositionRevision, query: 'novák', resourceTypes: [] },
      { compositionRevision, query: 'novák', resourceTypes: ['demo.crm.client', 'party.registry.counterparty'] },
    ]);
    expect(recordedPayloads(bff).some(({ resourceTypes }) => resourceTypes === undefined)).toBe(false);
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
    const bff = searchBff((payload) => (payload.resourceTypes === undefined ? unfilteredHit() : inventoryAnswer()));
    const model = yield* runReadySearch(bff, ['missing']);
    expect(recordedPayloads(bff)).toEqual([{ compositionRevision, query: 'novák', resourceTypes: [] }]);
    expect(model.filters).toMatchObject({ resourceTypes: [], selectedFamilies: [] });
    expect(model.filters.availableFamilies.map(({ key }) => key)).toEqual(['companies', 'work']);
    expect(model.response.results).toEqual([]);
    expect(model.response.presentation).toBeDefined();
    expect(model.index).toBeDefined();
  }),
);

it.effect('a known family mixed with an unknown one asks the inventory alone and shows nothing', () =>
  Effect.gen(function* mixedFamilySearch() {
    const bff = searchBff((payload) => (payload.resourceTypes === undefined ? unfilteredHit() : inventoryAnswer()));
    const model = yield* runReadySearch(bff, ['work', 'missing']);
    expect(recordedPayloads(bff)).toEqual([{ compositionRevision, query: 'novák', resourceTypes: [] }]);
    expect(model.filters).toMatchObject({ resourceTypes: [], selectedFamilies: ['work'] });
    expect(model.response.results).toEqual([]);
    expect(model.filters.availableFamilies.map(({ key }) => key)).toEqual(['companies', 'work']);
  }),
);

it.effect('a malformed family filter asks the inventory alone and never widens to the unfiltered answer', () =>
  Effect.gen(function* malformedFamilySearch() {
    const bff = searchBff((payload) => (payload.resourceTypes === undefined ? unfilteredHit() : inventoryAnswer()));
    const model = yield* runReadySearch(bff, searchFamiliesFromValue('Invalid Key'));
    expect(recordedPayloads(bff)).toEqual([{ compositionRevision, query: 'novák', resourceTypes: [] }]);
    expect(model.response.results).toEqual([]);
    expect(model.filters.availableFamilies.map(({ key }) => key)).toEqual(['companies', 'work']);
  }),
);

it.effect('a partial inventory answer issues one request and offers no filter', () =>
  Effect.gen(function* partialSearch() {
    const bff = searchBff(() => ({ partial: true, presentation: presentationInventory(), results: [] }));
    const model = yield* runReadySearch(bff, ['companies']);
    expect(recordedPayloads(bff)).toEqual([{ compositionRevision, query: 'novák', resourceTypes: [] }]);
    expect(model.filters).toEqual({ availableFamilies: [], selectedFamilies: [] });
    expect(model.response.partial).toBe(true);
  }),
);

const searchUrl = 'https://ontos.test/en/search?q=Morava';

/** Server rendering: no browser document, as the SSR loader on Node and Workers runs. */
const asServerRender = <Value, Failure, Requirements>(operation: Effect.Effect<Value, Failure, Requirements>) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  return Effect.acquireUseRelease(
    Effect.sync(() => Reflect.deleteProperty(globalThis, 'document')),
    () => operation,
    () =>
      Effect.sync(() => {
        if (descriptor !== undefined) {
          Object.defineProperty(globalThis, 'document', descriptor);
        }
      }),
  );
};
// happy-dom's Request drops the cookie header (a browser-forbidden name); the server's request carries it.
const serverRequest = () =>
  Object.defineProperty(new Request(searchUrl), 'headers', {
    value: new Headers({ cookie: 'better-auth.session_token=test-session' }),
  });

/** The document context the BFF answers server rendering with: Ada, signed in, one available composition. */
const signedInDocument = Schema.decodeUnknownSync(ShellDocumentContextSchema)({
  canManagePeople: false,
  composition: {
    compositionRevision: shellCompositionRevision,
    deniedAppIds: [],
    gatewayAudiences: [],
    homeComponents: [],
    navigation: [],
    state: 'available',
    unavailableDeployments: [],
  },
  home: { contribution: { state: 'forbidden' } },
  legalEntities: Schema.encodeSync(AvailableLegalEntitiesResponseSchema)(
    Schema.decodeUnknownSync(AvailableLegalEntitiesResponseSchema)({
      legalEntities: [{ legalEntityId: '20000000-0000-4000-8000-000000000001', legalName: 'Alpha company' }],
      selectedLegalEntityId: '20000000-0000-4000-8000-000000000001',
      state: 'authenticated',
      tenantContextAvailable: false,
    }),
  ),
  session: { identity: adaSignedIn.identity, state: 'authenticated' },
  tenants: { state: 'available', tenants: [] },
});

it.live('a server render returns the shell with the query pending and never runs the search', () => {
  const bff = searchBff(unfilteredHit, { documentContext: () => Effect.succeed(signedInDocument) });
  return Effect.gen(function* serverRenderSearch() {
    const model = yield* asServerRender(Effect.promise(() => loader({ request: serverRequest() })));
    expect(recordedPayloads(bff)).toEqual([]);
    expect(model).toMatchObject({ query: 'Morava', state: 'pending' });
    expect(model.shell.state).toBe('authenticated');
  }).pipe(Effect.provide(bff.browser));
});

it.live('the browser loader still returns the answered search', () => {
  const bff = searchBff(unfilteredHit, signedInShellReads(adaSignedIn));
  return Effect.gen(function* browserSearch() {
    yield* resetBrowserSessionCache;
    const model = yield* Effect.promise(() => loader({ request: new Request(searchUrl) }));
    expect(recordedPayloads(bff)).toEqual([{ compositionRevision: shellCompositionRevision, query: 'Morava' }]);
    expect(model).toMatchObject({ query: 'Morava', state: 'ready' });
    expect(model.state === 'ready' ? model.response.results.map(({ title }) => title) : []).toEqual(['Unfiltered hit']);
  }).pipe(Effect.provide(bff.browser));
});
