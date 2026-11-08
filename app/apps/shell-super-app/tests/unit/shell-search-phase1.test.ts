import { makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import type { ShellAccessGate } from '../../api/modules/shell-access-decisions.ts';
import type { TenantModuleState } from '@app/core-runtime';
import { ReadInputValidationError } from '@app/core-runtime';
import { corePeopleSystemSearchProvider } from '@app/core-runtime/people/search';
import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { makeInstalledModuleCatalogLoader } from '../../api/modules/installed-module-catalog.ts';
import { validateShellSearchResourceTypes } from '../../api/modules/shell-governed-reads.ts';
import { compileShellSearchPresentation } from '../../api/modules/shell-search-presentation.ts';
import {
  makeShellSearch,
  shellSearchAdmittedResourceTypes,
  ShellProviderUnavailableError,
} from '../../api/modules/shell-resources.ts';
import {
  ResourceRefSchema,
  ShellResourceDetailResponseSchema,
  ShellResourceResponseSchema,
  ShellSearchPayloadSchema,
  ShellSearchRelevanceSchema,
  ShellSearchResponseSchema,
  SHELL_SEARCH_MAX_RESOURCE_TYPES,
} from '../../shared/api.ts';
import type { ShellSearchResult } from '../../shared/api.ts';
import {
  shellSearchFamilies,
  shellSearchPresentationIndex,
  shellSearchResourceTypesForGroups,
} from '../../src/routes/shell-search-resource-types.ts';

const alphaModule = 'alpha.registry';
const alphaType = 'alpha.registry.record';
const betaModule = 'beta.registry';
const betaType = 'beta.registry.record';
const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const compositionRevision = 'a'.repeat(64);
const context = {
  authMethod: 'system' as const,
  correlationId: 'shell-search-phase1',
  legalEntityId,
  principalId,
  tenantId,
} as const;

const moduleContract = (moduleId: string, appId: string, resourceType: string) => ({
  deployment: { appId, buildMarker: 'phase1-test' },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates: ['inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'],
    },
    module: {
      description: `${moduleId} records.`,
      displayName: moduleId,
      id: moduleId,
      implementedAs: 'ultramodern_microvertical',
      kind: 'business_module',
    },
    publicSurface: {
      actions: [],
      api: [],
      components: [],
      events: [],
      reports: [],
      resourceTypes: [
        {
          capabilities: {
            graphVisible: false,
            linkable: true,
            mediaAttachable: false,
            searchable: true,
            timelineVisible: false,
          },
          description: `${resourceType} record.`,
          key: resourceType,
          label: resourceType,
          owningModuleId: moduleId,
        },
      ],
      search: [
        {
          accessFiltering: 'resource_permission',
          key: `${moduleId}.search`,
          owningModuleId: moduleId,
          resourceType,
        },
      ],
      shellContributions: {
        mediaAttachments: [],
        navigation: [],
        pages: [],
        publicComponents: [],
        reports: [],
        resourceDetails: [],
        search: [
          {
            accessDeclaration: {
              key: `${moduleId}.records.read`,
              kind: 'read',
              modes: ['run'],
              placement: { group: 'records', level: 'basic' },
              risk: 'routine',
              selectors: [],
            },
            contributionKey: `${moduleId}.search.contribution`,
            entrypoint: {
              access: 'read',
              authorization: { kind: 'protected' },
              entrypointKey: `${moduleId}.search`,
              moduleKey: moduleId,
              role: 'search',
              scope: 'tenant',
            },
            searchKey: `${moduleId}.search`,
          },
        ],
        timelines: [],
      },
    },
  },
  runtime: { outboxSubscriptions: [] },
  schemaVersion: '2',
});

const catalogEffect = makeInstalledModuleCatalogLoader(
  makeCompositionSnapshot([
    moduleContract(alphaModule, 'alpha-registry', alphaType),
    moduleContract(betaModule, 'beta-registry', betaType),
  ]),
);

const allowedSearchGate = () =>
  makeTestAccessDecision({
    answers: {
      [`${alphaModule}.records.read`]: { outcome: 'ALLOWED' },
      [`${betaModule}.records.read`]: { outcome: 'ALLOWED' },
    },
  });

const dependencies = (
  catalog: Effect.Success<typeof catalogEffect>,
  options: {
    readonly access?: ShellAccessGate;
    readonly states?: Readonly<Record<string, TenantModuleState>>;
  } = {},
) => {
  let assertion = 0;
  return {
    access: options.access ?? allowedSearchGate(),
    catalog: Effect.succeed(catalog),
    issueAssertion: () => {
      assertion += 1;
      return Effect.succeed(`Bearer phase1-${assertion}`);
    },
    moduleStates: {
      getTenantModuleStates: (_tenantId: string, moduleIds: readonly string[]) =>
        Effect.succeed(
          moduleIds.flatMap((moduleKey) => {
            const state = options.states?.[moduleKey] ?? 'active';
            return [{ moduleKey, state }];
          }),
        ),
    },
  };
};

interface WireRelevance {
  readonly score: number;
  readonly version: string;
}

const resourceHit = (
  moduleId: string,
  resourceType: string,
  resourceId: string,
  title: string,
  relevance?: WireRelevance,
) => {
  const hit = {
    ref: { moduleId, resourceId, resourceType, tenantId },
    selectedLegalEntityId: legalEntityId,
    title,
  };
  // A legacy owner omits the property entirely; the Shell never materializes an invented score.
  return relevance === undefined ? hit : { ...hit, relevance };
};

const titles = (results: readonly ShellSearchResult[]): readonly string[] =>
  results.flatMap(({ title }) => (title === undefined ? [] : [title]));

const decodeRelevance = (input: { readonly score?: number; readonly version?: string }) =>
  Schema.decodeUnknownResult(ShellSearchRelevanceSchema)(input);

it.effect('a legacy request without resourceTypes asks every admitted owner and keeps every authorized hit', () =>
  Effect.gen(function* legacySearch() {
    const catalog = yield* catalogEffect;
    const asked: string[] = [];
    const result = yield* makeShellSearch(dependencies(catalog), {
      search: ({ searchKey }) => {
        if (searchKey === undefined) {
          return Effect.die('Approved search provider has no search key');
        }
        asked.push(searchKey);
        return Effect.succeed([
          searchKey === `${alphaModule}.search`
            ? resourceHit(alphaModule, alphaType, 'alpha-1', 'Alfa')
            : resourceHit(betaModule, betaType, 'beta-1', 'Beta'),
        ]);
      },
    }).search(context, 'record');
    expect(asked.toSorted()).toEqual([`${alphaModule}.search`, `${betaModule}.search`]);
    expect(titles(result.results)).toEqual(['Alfa', 'Beta']);
    // Old providers omit relevance, so the Shell neither invents one nor adds the property.
    expect(result.results.every((hit) => !('relevance' in hit))).toBe(true);
  }),
);

it.effect('an explicit empty resourceTypes list returns the admitted inventory and asks no owner', () =>
  Effect.gen(function* emptyTypes() {
    const catalog = yield* catalogEffect;
    let ownerCalls = 0;
    let stateCalls = 0;
    const baseline = dependencies(catalog);
    const result = yield* makeShellSearch(
      {
        ...baseline,
        moduleStates: {
          getTenantModuleStates: (tenant, ids) => {
            stateCalls += 1;
            return baseline.moduleStates.getTenantModuleStates(tenant, ids);
          },
        },
      },
      {
        search: () => {
          ownerCalls += 1;
          return Effect.succeed([]);
        },
      },
    ).search(context, { query: 'record', resourceTypes: [] });
    // The inventory request still evaluates every admitted provider's committed state, but it dispatches no owner
    // assertion and returns no fabricated hit. The inventory itself is the release-bound admitted one.
    expect(result.partial).toBe(false);
    expect(result.results).toEqual([]);
    expect(result.presentation?.business.compositionRevision).toBe(catalog.composition.revision);
    expect(result.presentation?.business.entries).toEqual([]);
    expect(ownerCalls).toBe(0);
    expect(stateCalls).toBe(1);
  }),
);

it.effect('resourceTypes narrows owner and permission work to the requested admitted type', () =>
  Effect.gen(function* narrowedSearch() {
    const catalog = yield* catalogEffect;
    const asked: string[] = [];
    const moduleChecks: (readonly string[])[] = [];
    const gate = allowedSearchGate();
    const result = yield* makeShellSearch(
      dependencies(catalog, {
        access: {
          ...gate,
          decideMany: (input) => {
            moduleChecks.push(
              input.flatMap(({ carrier }) =>
                carrier.accessDeclaration?.key === `${alphaModule}.records.read` ? [alphaModule] : [],
              ),
            );
            return gate.decideMany(input);
          },
        },
      }),
      {
        search: ({ searchKey }) => {
          if (searchKey === undefined) {
            return Effect.die('Approved search provider has no search key');
          }
          asked.push(searchKey);
          return Effect.succeed([resourceHit(alphaModule, alphaType, 'alpha-1', 'Alfa')]);
        },
      },
    ).search(context, { query: 'record', resourceTypes: [alphaType] });
    expect(asked).toEqual([`${alphaModule}.search`]);
    // The selected type must still pass module permission; the filter never replaces authorization.
    expect(moduleChecks).toEqual([[alphaModule]]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.ref.resourceType).toBe(alphaType);
  }),
);

it.effect('verified relevance sorts globally by score, then normalized title and typed reference', () =>
  Effect.gen(function* relevanceOrder() {
    const catalog = yield* catalogEffect;
    const result = yield* makeShellSearch(dependencies(catalog), {
      search: ({ searchKey }) =>
        Effect.succeed(
          searchKey === `${alphaModule}.search`
            ? [
                resourceHit(alphaModule, alphaType, 'alpha-1', 'Žofie', { score: 900, version: '1' }),
                resourceHit(alphaModule, alphaType, 'alpha-2', 'Shoda', { score: 500, version: '1' }),
                resourceHit(alphaModule, alphaType, 'alpha-3', 'Bez skóre'),
              ]
            : [
                resourceHit(betaModule, betaType, 'beta-1', 'Eva', { score: 900, version: '1' }),
                resourceHit(betaModule, betaType, 'beta-2', 'shoda', { score: 500, version: '1' }),
                resourceHit(betaModule, betaType, 'beta-3', 'Novák', { score: 100, version: '1' }),
              ],
        ),
    }).search(context, 'record');
    // 900: 'Eva' before 'Žofie' after normalization. 500: equal normalized title, so the typed ref decides and
    // alpha.registry sorts before beta.registry. Then the verified 100, and finally the legacy hit without a score.
    expect(result.results.map(({ ref }) => ref.resourceId)).toEqual([
      'beta-1',
      'alpha-1',
      'alpha-2',
      'beta-2',
      'beta-3',
      'alpha-3',
    ]);
    expect(result.results[0]?.relevance).toEqual({ score: 900, version: '1' });
    expect(result.results.at(-1)?.relevance).toBeUndefined();
  }),
);

it.effect('owners that omit relevance keep the existing title-first default order', () =>
  Effect.gen(function* legacyOrder() {
    const catalog = yield* catalogEffect;
    const result = yield* makeShellSearch(dependencies(catalog), {
      search: ({ searchKey }) =>
        Effect.succeed(
          searchKey === `${alphaModule}.search`
            ? [
                resourceHit(alphaModule, alphaType, 'alpha-2', 'Žofie'),
                resourceHit(alphaModule, alphaType, 'alpha-1', 'Eva'),
              ]
            : [resourceHit(betaModule, betaType, 'beta-1', 'eva')],
        ),
    }).search(context, 'record');
    // 'Eva' and 'eva' normalize equal, so the typed reference breaks the tie deterministically.
    expect(result.results.map(({ ref }) => `${ref.moduleId}:${ref.resourceId}`)).toEqual([
      'alpha.registry:alpha-1',
      'beta.registry:beta-1',
      'alpha.registry:alpha-2',
    ]);
  }),
);

for (const relevance of [
  { score: -1, version: '1' },
  { score: 1001, version: '1' },
  { score: 700.5, version: '1' },
  { score: 700, version: '2' },
]) {
  it.effect(`rejects unverified relevance ${JSON.stringify(relevance)} instead of ranking it`, () =>
    Effect.gen(function* invalidRelevance() {
      const catalog = yield* catalogEffect;
      const failure = yield* makeShellSearch(dependencies(catalog), {
        search: () => Effect.succeed([resourceHit(alphaModule, alphaType, 'alpha-1', 'Alfa', relevance)]),
      })
        .search(context, { query: 'record', resourceTypes: [alphaType] })
        .pipe(Effect.flip);
      // An owner that cannot prove exact relevance fails closed; a bad score never becomes a fake rank.
      expect(Schema.is(ShellProviderUnavailableError)(failure)).toBe(true);
    }),
  );
}

it.effect('discards a foreign provider hit carrying relevance before dedupe and sorting', () =>
  Effect.gen(function* foreignHit() {
    const catalog = yield* catalogEffect;
    const result = yield* makeShellSearch(dependencies(catalog), {
      search: ({ searchKey }) =>
        Effect.succeed(
          searchKey === `${alphaModule}.search`
            ? [
                resourceHit(alphaModule, alphaType, 'alpha-1', 'Alfa', { score: 100, version: '1' }),
                resourceHit(betaModule, betaType, 'spoofed', 'Podvržená Beta', { score: 1000, version: '1' }),
              ]
            : [],
        ),
    }).search(context, { query: 'record', resourceTypes: [alphaType] });
    expect(result.results.map(({ ref }) => ref.resourceId)).toEqual(['alpha-1']);
    expect(result.results[0]?.relevance).toEqual({ score: 100, version: '1' });
  }),
);

const betaFails = (searchKey: string) => searchKey === `${betaModule}.search`;

it.effect(
  'a failed owner is omitted as partial, a narrowed request never calls it, and all failing is unavailable',
  () =>
    Effect.gen(function* partialFailure() {
      const catalog = yield* catalogEffect;
      const search = (failing: (searchKey: string) => boolean, resourceTypes?: readonly string[]) =>
        makeShellSearch(dependencies(catalog), {
          search: ({ searchKey }) =>
            failing(searchKey)
              ? Effect.fail(new ShellProviderUnavailableError())
              : Effect.succeed([resourceHit(alphaModule, alphaType, 'alpha-1', 'Alfa')]),
        }).search(context, resourceTypes === undefined ? { query: 'record' } : { query: 'record', resourceTypes });
      const partial = yield* search(betaFails);
      expect(partial.partial).toBe(true);
      expect(titles(partial.results)).toEqual(['Alfa']);
      const narrowed = yield* search(betaFails, [alphaType]);
      expect(narrowed.partial).toBe(false);
      expect(titles(narrowed.results)).toEqual(['Alfa']);
      expect(Schema.is(ShellProviderUnavailableError)(yield* search(() => true).pipe(Effect.flip))).toBe(true);
    }),
);

it.effect('owner-filtered counterparty results exclude private collision refs before Shell relevance ordering', () =>
  Effect.gen(function* collision() {
    const catalog = yield* catalogEffect;
    const collisionRef = (resourceId: string) => ({
      moduleId: alphaModule,
      resourceId,
      resourceType: alphaType,
      tenantId,
    });
    const counterparty = {
      currentRoles: ['CUSTOMER' as const],
      legalEntity: { legalEntityId, tenantId },
      party: { archived: false, matchedViaAlias: false, ref: collisionRef('party-1'), title: 'Eva Bílá' },
      ref: collisionRef('alpha-1'),
      relevance: { score: 10, version: '1' as const },
    };
    const result = yield* makeShellSearch(dependencies(catalog), {
      search: () =>
        Effect.succeed([
          {
            ...counterparty,
            privateCollisionRefs: [collisionRef('denied-1')],
          },
          resourceHit(alphaModule, alphaType, 'alpha-2', 'Alfa', { score: 500, version: '1' }),
        ]),
    }).search(context, { query: 'record', resourceTypes: [alphaType] });
    // The owner filters its records; Shell projects only the public DTO, never private collision metadata.
    // The surviving counterparty keeps its verified relevance and follows the stronger resource hit.
    expect(result.results.map(({ title }) => title)).toEqual(['Alfa', 'Eva Bílá']);
    const [, visible] = result.results;
    expect(visible?.kind).toBe('counterparty');
    expect(visible === undefined || visible.kind !== 'counterparty' ? undefined : visible.collision).toBeUndefined();
    expect(visible?.relevance).toEqual({ score: 10, version: '1' });
    expect(JSON.stringify(result)).not.toContain('denied-1');
  }),
);

it.effect('admitted types follow the captured catalog and tenant state, while unknown types stay unadmitted', () =>
  Effect.gen(function* admission() {
    const catalog = yield* catalogEffect;
    expect(
      shellSearchAdmittedResourceTypes(catalog, [
        { moduleKey: alphaModule, state: 'active' },
        { moduleKey: betaModule, state: 'active' },
      ]),
    ).toEqual([alphaType, betaType]);
    expect(
      shellSearchAdmittedResourceTypes(catalog, [
        { moduleKey: alphaModule, state: 'active' },
        { moduleKey: betaModule, state: 'suspended' },
      ]),
    ).toEqual([alphaType]);
    expect(shellSearchAdmittedResourceTypes(catalog, [{ moduleKey: alphaModule, state: 'active' }])).toEqual([
      alphaType,
    ]);
    expect(shellSearchAdmittedResourceTypes(catalog, [])).toEqual([]);
    yield* validateShellSearchResourceTypes(undefined, new Set([alphaType]));
    yield* validateShellSearchResourceTypes([alphaType], new Set([alphaType]));
    const unknown = yield* validateShellSearchResourceTypes(['unknown.type'], new Set([alphaType])).pipe(Effect.flip);
    expect(Schema.is(ReadInputValidationError)(unknown)).toBe(true);
    expect(unknown.code).toBe('read_input_invalid');
    const unadmitted = yield* validateShellSearchResourceTypes([betaType], new Set([alphaType])).pipe(Effect.flip);
    // Unknown and unadmitted share one request error, so a denied module is not distinguishable from a missing type.
    expect(Schema.is(ReadInputValidationError)(unadmitted)).toBe(true);
    expect(unadmitted.reason).toBe('The requested search resource types are not admitted');
  }),
);

it.effect('an unadmitted type never reaches its owner and cannot widen a search', () =>
  Effect.gen(function* unadmittedSearch() {
    const catalog = yield* catalogEffect;
    let betaCalls = 0;
    const result = yield* makeShellSearch(
      dependencies(catalog, {
        access: makeTestAccessDecision({
          answers: {
            [`${alphaModule}.records.read`]: { outcome: 'ALLOWED' },
            [`${betaModule}.records.read`]: { outcome: 'DENIED' },
          },
        }),
      }),
      {
        search: ({ searchKey }) => {
          betaCalls += searchKey === `${betaModule}.search` ? 1 : 0;
          return Effect.succeed([]);
        },
      },
    ).search(context, { query: 'record', resourceTypes: [betaType] });
    // Selection narrows an authorized fan-out; a denied module simply yields no hit instead of a grant.
    expect(result).toEqual({
      partial: false,
      presentation: {
        business: { compositionRevision: catalog.composition.revision, entries: [], schemaVersion: '1' },
        pages: [],
      },
      results: [],
    });
    expect(betaCalls).toBe(0);
  }),
);

it('accepts at most 64 requested resource types in the governed search payload', () => {
  const payload = (count: number) => ({
    compositionRevision,
    query: 'record',
    resourceTypes: Array.from({ length: count }, (_, index) => `owner.record-${index}`),
  });
  expect(SHELL_SEARCH_MAX_RESOURCE_TYPES).toBe(64);
  expect(Result.isSuccess(Schema.decodeUnknownResult(ShellSearchPayloadSchema)(payload(64)))).toBe(true);
  expect(Result.isFailure(Schema.decodeUnknownResult(ShellSearchPayloadSchema)(payload(65)))).toBe(true);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ShellSearchPayloadSchema)({ compositionRevision, query: 'record', resourceTypes: [] }),
    ),
  ).toBe(true);
});

it('keeps wire relevance versioned and bounded to an integer score between 0 and 1000', () => {
  expect(Result.isSuccess(decodeRelevance({ score: 0, version: '1' }))).toBe(true);
  expect(Result.isSuccess(decodeRelevance({ score: 1000, version: '1' }))).toBe(true);
  expect(Result.isFailure(decodeRelevance({ score: 1001, version: '1' }))).toBe(true);
  expect(Result.isFailure(decodeRelevance({ score: 5.5, version: '1' }))).toBe(true);
  expect(Result.isFailure(decodeRelevance({ score: 5, version: '2' }))).toBe(true);
  expect(Result.isFailure(decodeRelevance({ score: 5 }))).toBe(true);
});

it('preserves the existing resource detail wire union, including detail_not_supported', () => {
  const ref = Schema.decodeUnknownSync(ResourceRefSchema)({
    moduleId: alphaModule,
    resourceId: 'alpha-1',
    resourceType: alphaType,
    tenantId,
  });
  const unsupported = Schema.decodeUnknownResult(ShellResourceResponseSchema)({
    outcome: 'detail_not_supported',
    ref,
  });
  expect(Result.isSuccess(unsupported)).toBe(true);
  const rawDetail = {
    detail: { fields: [{ label: 'Stav', value: 'Aktivní' }], title: 'Alfa 1' },
    media: { enabled: false, reason: 'absent' },
    projectionLagging: false,
    ref,
    timeline: [{ occurredAt: '2026-11-03T00:00:00.000Z', summary: 'Vznik', timelineEntryId: 'entry-1' }],
  };
  expect(Result.isSuccess(Schema.decodeUnknownResult(ShellResourceDetailResponseSchema)(rawDetail))).toBe(true);
  expect(Result.isSuccess(Schema.decodeUnknownResult(ShellResourceResponseSchema)(rawDetail))).toBe(true);
  // A search response still carries the same hit variants, now with optional relevance.
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ShellSearchResponseSchema)({
        partial: false,
        results: [
          {
            ...resourceHit(alphaModule, alphaType, 'alpha-1', 'Alfa'),
            kind: 'resource',
            relevance: { score: 1, version: '1' },
          },
        ],
      }),
    ),
  ).toBe(true);
});

it.effect(
  'maps only the captured admitted owner and Core system groups to exact request types, without broadening unresolved selections',
  () =>
    Effect.gen(function* declaredGroupFilters() {
      const inputs = [
        moduleContract(alphaModule, 'alpha-registry', alphaType),
        moduleContract(betaModule, 'beta-registry', betaType),
      ].map((contract) => ({
        ...contract,
        manifest: {
          ...contract.manifest,
          publicSurface: {
            ...contract.manifest.publicSurface,
            shellContributions: {
              ...contract.manifest.publicSurface.shellContributions,
              search: contract.manifest.publicSurface.shellContributions.search.map((contribution) => ({
                ...contribution,
                presentation: {
                  family: {
                    icon: 'icon-[mdi--folder]',
                    key: 'records',
                    label: { cs: 'Záznamy', en: 'Records' },
                    order: 1,
                  },
                  group: { icon: 'icon-[mdi--file]', key: 'record', label: { cs: 'Záznamy', en: 'Records' }, order: 1 },
                  scope: 'company',
                },
              })),
            },
          },
        },
      }));
      const catalog = yield* makeInstalledModuleCatalogLoader(makeCompositionSnapshot(inputs));
      const provider = corePeopleSystemSearchProvider;
      const compiled = compileShellSearchPresentation({
        admitted: catalog.contracts.flatMap(({ manifest }) =>
          manifest.publicSurface.search.map((descriptor) => ({
            ownerModuleId: descriptor.owningModuleId,
            resourceType: descriptor.resourceType,
            searchKey: descriptor.key,
          })),
        ),
        catalog,
        compositionRevision: catalog.composition.revision,
        system: {
          authority: {
            entrypointKey: provider.entrypoint.entrypointKey,
            navigationPath: provider.navigationPath,
            ownerModuleId: provider.descriptor.owningModuleId,
            resourceType: provider.resource.key,
            searchKey: provider.descriptor.key,
          },
          presentation: provider.presentation,
        },
      });
      if (Result.isFailure(compiled)) {
        throw new Error(compiled.failure.message);
      }
      const index = shellSearchPresentationIndex(compiled.success, catalog.composition.revision);
      expect(shellSearchResourceTypesForGroups(index, ['record'])).toEqual([alphaType, betaType]);
      expect(shellSearchResourceTypesForGroups(index, [provider.presentation.group.key])).toEqual([
        provider.resource.key,
      ]);
      expect(shellSearchResourceTypesForGroups(index, [])).toEqual([]);
      expect(shellSearchResourceTypesForGroups(index, ['unknown'])).toEqual([]);
      expect(shellSearchResourceTypesForGroups(undefined, ['record'])).toEqual([]);
      const stale = shellSearchPresentationIndex(compiled.success, 'f'.repeat(64));
      expect(shellSearchResourceTypesForGroups(stale, ['record'])).toEqual([]);
      expect(
        shellSearchFamilies(index).find((family) => family.key === provider.presentation.family.key)?.resourceTypes,
      ).toContain(provider.resource.key);
    }),
);
