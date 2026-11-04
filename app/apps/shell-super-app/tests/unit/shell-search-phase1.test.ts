import type { ContextAccessService, TenantModuleState } from '@app/core-runtime';
import { ReadInputValidationError } from '@app/core-runtime';
import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { makeInstalledModuleCatalogLoader } from '../../api/modules/installed-module-catalog.ts';
import { validateShellSearchResourceTypes } from '../../api/modules/shell-governed-reads.ts';
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
  shellSearchPresentationContext,
  shellSearchResourceTypesForGroups,
} from '../../src/routes/shell-search-resource-types.ts';
import type { ShellSearchGroupInput } from '../../src/routes/shell-search-resource-types.ts';

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
            contributionKey: `${moduleId}.search.contribution`,
            entrypoint: {
              access: 'read',
              authorization: { kind: 'context_permission', permission: 'module.access' },
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

const allowedModules: ContextAccessService['modules'] = ({ moduleIds }) =>
  Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key })));

const allowedResources: ContextAccessService['resources'] = ({ resources }) =>
  Effect.succeed(
    resources.map(({ moduleId, resourceId, resourceType }) => ({
      decision: 'allowed' as const,
      key: `${moduleId}:${resourceType}:${resourceId}`,
    })),
  );

const access = (options: {
  readonly modules?: ContextAccessService['modules'];
  readonly resources?: ContextAccessService['resources'];
}): ContextAccessService => ({
  legalEntities: () => Effect.succeed([]),
  modules: options.modules ?? allowedModules,
  resources: options.resources ?? allowedResources,
  tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
});

const dependencies = (
  catalog: Effect.Success<typeof catalogEffect>,
  options: {
    readonly contextAccess?: ContextAccessService;
    readonly states?: Readonly<Record<string, TenantModuleState>>;
  } = {},
) => {
  let assertion = 0;
  return {
    catalog: Effect.succeed(catalog),
    contextAccess: options.contextAccess ?? access({}),
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

const titles = (results: readonly ShellSearchResult[]): readonly string[] => results.map(({ title }) => title);

const decodeRelevance = (input: { readonly score?: number; readonly version?: string }) =>
  Schema.decodeUnknownResult(ShellSearchRelevanceSchema)(input);

it.effect('a legacy request without resourceTypes asks every admitted owner and keeps every authorized hit', () =>
  Effect.gen(function* legacySearch() {
    const catalog = yield* catalogEffect;
    const asked: string[] = [];
    const result = yield* makeShellSearch(dependencies(catalog), {
      search: ({ searchKey }) => {
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

it.effect('an explicit empty resourceTypes list asks no owner and returns no hit', () =>
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
    expect(result).toEqual({ partial: false, results: [] });
    expect(ownerCalls).toBe(0);
    expect(stateCalls).toBe(0);
  }),
);

it.effect('resourceTypes narrows owner and permission work to the requested admitted type', () =>
  Effect.gen(function* narrowedSearch() {
    const catalog = yield* catalogEffect;
    const asked: string[] = [];
    const moduleChecks: (readonly string[])[] = [];
    const result = yield* makeShellSearch(
      dependencies(catalog, {
        contextAccess: access({
          modules: (input) => {
            moduleChecks.push(input.moduleIds);
            return allowedModules(input);
          },
        }),
      }),
      {
        search: ({ searchKey }) => {
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

it.effect('a partial owner failure stays unavailable while a narrowed request never calls the failing owner', () =>
  Effect.gen(function* partialFailure() {
    const catalog = yield* catalogEffect;
    const search = (resourceTypes?: readonly string[]) =>
      makeShellSearch(dependencies(catalog), {
        search: ({ searchKey }) =>
          searchKey === `${betaModule}.search`
            ? Effect.fail(new ShellProviderUnavailableError())
            : Effect.succeed([resourceHit(alphaModule, alphaType, 'alpha-1', 'Alfa')]),
      }).search(context, resourceTypes === undefined ? { query: 'record' } : { query: 'record', resourceTypes });
    expect(Schema.is(ShellProviderUnavailableError)(yield* search().pipe(Effect.flip))).toBe(true);
    const narrowed = yield* search([alphaType]);
    expect(titles(narrowed.results)).toEqual(['Alfa']);
  }),
);

it.effect('counterparty collision is sanitized by record permission and only then ordered by relevance', () =>
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
    const result = yield* makeShellSearch(
      dependencies(catalog, {
        contextAccess: access({
          resources: ({ resources }) =>
            Effect.succeed(
              resources.map(({ moduleId, resourceId, resourceType }) => ({
                decision: resourceId.startsWith('denied') ? ('denied' as const) : ('allowed' as const),
                key: `${moduleId}:${resourceType}:${resourceId}`,
              })),
            ),
        }),
      }),
      {
        search: () =>
          Effect.succeed([
            {
              ...counterparty,
              collision: {
                counterpartyRefs: [collisionRef('denied-1')],
                kind: 'CANONICAL_PARTY_COUNTERPARTY_COLLISION',
              },
            },
            resourceHit(alphaModule, alphaType, 'alpha-2', 'Alfa', { score: 500, version: '1' }),
          ]),
      },
    ).search(context, { query: 'record', resourceTypes: [alphaType] });
    // One readable collision ref cannot stay a collision. Sanitization happens before the global order, so the
    // surviving counterparty keeps its verified relevance and follows the stronger resource hit.
    expect(result.results.map(({ title }) => title)).toEqual(['Alfa', 'Eva Bílá']);
    const [, visible] = result.results;
    expect(visible?.kind).toBe('counterparty');
    expect(visible === undefined || visible.kind !== 'counterparty' ? undefined : visible.collision).toBeUndefined();
    expect(visible?.relevance).toEqual({ score: 10, version: '1' });
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
        contextAccess: access({
          modules: ({ moduleIds }) =>
            Effect.succeed(
              moduleIds.map((key) => ({
                decision: key === betaModule ? ('denied' as const) : ('allowed' as const),
                key,
              })),
            ),
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
    expect(result).toEqual({ partial: false, results: [] });
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

/** The composed navigation of the demo document: the destinations those record types open, and their sections. */
const searchNavigation = [
  { groupKey: 'shell.navigation.finance', href: '/finance', moduleId: 'finance.billing' },
  { groupKey: 'shell.navigation.sales', href: '/crm/klienti', moduleId: 'demo.crm' },
  { groupKey: 'shell.navigation.sales', href: '/prodej/zakaznici', moduleId: 'party.registry' },
  { groupKey: 'shell.navigation.sales', href: '/prodej/prilezitosti', moduleId: 'demo.sales-pipeline' },
  { groupKey: 'shell.navigation.sales', href: '/smlouvy', moduleId: 'legal.agreements' },
  { groupKey: 'shell.navigation.commerce', href: '/prodej/objednavky', moduleId: 'demo.merchandise' },
  { groupKey: 'shell.navigation.commerce', href: '/provoz/produkty', moduleId: 'demo.merchandise' },
  { groupKey: 'shell.navigation.commerce', href: '/prodej/eshopy', moduleId: 'commerce.market-catalog' },
  { groupKey: 'shell.navigation.team', href: '/ukoly', moduleId: 'work.tasks' },
  { groupKey: 'shell.navigation.real-estate', href: '/nemovitosti', moduleId: 'property.portfolio' },
  { groupKey: 'shell.navigation.real-estate', href: '/najmy', moduleId: 'property.leasing' },
  { groupKey: 'shell.navigation.facility', href: '/provoz/majetek', moduleId: 'facility.operations' },
  { groupKey: 'shell.navigation.facility', href: '/provoz/bezpecnost', moduleId: 'facility.operations' },
  { groupKey: 'shell.navigation.facility', href: '/provoz/meridla', moduleId: 'facility.operations' },
  { groupKey: 'shell.navigation.facility', href: '/provoz/dokumenty', moduleId: 'facility.operations' },
] as const;
const presentation = shellSearchPresentationContext(searchNavigation);

/** One observed hit per registered searchable type, in the order the demo composition lists them. */
const observedSearchTypes = [
  ['core.identity', 'core.identity.person'],
  ['party.registry', 'party.registry.counterparty'],
  ['party.registry', 'party.registry.party'],
  ['demo.crm', 'demo.crm.client'],
  ['demo.crm', 'demo.crm.contact'],
  ['demo.sales-pipeline', 'demo.sales-pipeline.opportunity'],
  ['demo.merchandise', 'demo.merchandise.product'],
  ['demo.merchandise', 'demo.merchandise.order'],
  ['work.tasks', 'work.tasks.task'],
  ['finance.billing', 'finance.billing.invoice'],
  ['finance.billing', 'finance.billing.document'],
  ['legal.agreements', 'legal.agreements.contract'],
  ['legal.agreements', 'legal.agreements.document'],
  ['property.portfolio', 'property.portfolio.property'],
  ['property.portfolio', 'property.portfolio.unit'],
  ['property.portfolio', 'property.portfolio.asset'],
  ['facility.operations', 'facility.operations.asset'],
  ['facility.operations', 'facility.operations.device'],
  ['facility.operations', 'facility.operations.meter'],
  ['facility.operations', 'facility.operations.document'],
  ['property.leasing', 'property.leasing.occupancy'],
  ['commerce.market-catalog', 'commerce.market-catalog.market'],
] as const;
/** One hit of a searchable type, with the result kind its owner publishes; only the kind and the ref drive grouping. */
const observedHit = (moduleId: string, resourceType: string): ShellSearchGroupInput => {
  const ref = { moduleId, resourceId: resourceType, resourceType };
  if (resourceType.endsWith('.party')) {
    return { kind: 'party', ref };
  }
  if (resourceType.endsWith('.counterparty')) {
    return { kind: 'counterparty', ref };
  }
  return { kind: 'resource', ref };
};

const observed = observedSearchTypes.map(([moduleId, resourceType]) => observedHit(moduleId, resourceType));

it('maps Shell groups to the exact observed resourceTypes request filter, or undefined when incomplete', () => {
  expect(shellSearchResourceTypesForGroups(['task'], observed, presentation)).toEqual(['work.tasks.task']);
  expect(shellSearchResourceTypesForGroups(['invoice', 'financeDocument'], observed, presentation)).toEqual([
    'finance.billing.invoice',
    'finance.billing.document',
  ]);
  expect(shellSearchResourceTypesForGroups(['person'], observed, presentation)).toEqual(['core.identity.person']);
  expect(shellSearchResourceTypesForGroups(['asset'], observed, presentation)).toEqual([
    'property.portfolio.asset',
    'facility.operations.asset',
  ]);
  expect(shellSearchResourceTypesForGroups([], observed, presentation)).toEqual([]);
  // A declared group without a registered type is a complete, empty filter, not an incomplete one.
  expect(shellSearchResourceTypesForGroups(['sku'], observed, presentation)).toEqual([]);
  expect(shellSearchResourceTypesForGroups(['task', 'resource'], observed, presentation)).toBeUndefined();
  expect(shellSearchResourceTypesForGroups(['resource'], observed, presentation)).toBeUndefined();
  const everyGroup = shellSearchResourceTypesForGroups(
    [
      'counterparty',
      'party',
      'person',
      'crmClient',
      'crmContact',
      'opportunity',
      'product',
      'sku',
      'order',
      'task',
      'invoice',
      'financeDocument',
      'contract',
      'legalDocument',
      'property',
      'unit',
      'lease',
      'asset',
      'device',
      'facilityDocument',
      'market',
    ],
    observed,
    presentation,
  );
  // 20 named groups hold 22 observed types after the facility meter registration; `resource` stays excluded.
  expect(everyGroup).toHaveLength(22);
  expect(new Set(everyGroup).size).toBe(22);
});

it('dispatches only observed admitted types and never a forged owner in a family filter', () => {
  const forged = [
    ...observed,
    observedHit('unknown.owner', 'unknown.owner.product'),
    observedHit('demo.crm', 'demo.crm.invoice'),
    observedHit('finance.billing', 'finance.billing.client'),
  ];
  expect(shellSearchResourceTypesForGroups(['product'], forged, presentation)).toEqual(['demo.merchandise.product']);
  expect(shellSearchResourceTypesForGroups(['invoice'], forged, presentation)).toEqual(['finance.billing.invoice']);
  expect(shellSearchResourceTypesForGroups(['crmClient'], forged, presentation)).toEqual(['demo.crm.client']);
  expect(shellSearchResourceTypesForGroups(['resource'], forged, presentation)).toBeUndefined();
  // A family list is only as complete as the observed answer: an unobserved admitted type is never invented.
  const withoutTasks = forged.filter(({ ref }) => ref.resourceType !== 'work.tasks.task');
  expect(shellSearchResourceTypesForGroups(['task'], withoutTasks, presentation)).toEqual([]);
});
