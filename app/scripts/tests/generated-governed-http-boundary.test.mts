import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { hasCompleteGeneratedModuleApiSeam } from '../generated-governed-http-boundary.mts';

const marketCatalogOwner = 'commerce-market-catalog';
const financeBillingOwner = 'finance-billing';
const workTasksOwner = 'work-tasks';
const wholeMarketItems = 'items: (result: MarketsProviderResponse) => result,';
const coreOnlyDomainSchema = 'domainErrorSchema: Schema.Never,';

const authorizedItemsResult = 'withItems: (_result, items) => items,';

const loadOwnerSources = Effect.fn(function* loadOwnerSources(owner: string) {
  const root = path.resolve(import.meta.dirname, '../..');
  const sources = new Map<string, string>();
  const visit = (directory: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* visitOwnerDirectory() {
      const entries = yield* Effect.promise(() => readdir(path.join(root, directory), { withFileTypes: true }));
      for (const entry of entries) {
        const file = `${directory}/${entry.name}`;
        if (entry.isDirectory() && !['node_modules', 'dist', '.modern', '.output', 'coverage'].includes(entry.name)) {
          yield* visit(file);
        } else if (entry.isFile() && /\.(?:ts|json)$/u.test(file)) {
          sources.set(file, yield* Effect.promise(() => readFile(path.join(root, file), 'utf-8')));
        }
      }
    });
  yield* visit(`verticals/${owner}`);
  return sources;
});

const acceptsOwner = (sources: ReadonlyMap<string, string>, owner: string): boolean =>
  hasCompleteGeneratedModuleApiSeam(sources, `verticals/${owner}/shared/api.ts`, owner);

const expectValidOwner = (sources: ReadonlyMap<string, string>, owner: string): void => {
  const diagnostics: string[] = [];
  expect(
    hasCompleteGeneratedModuleApiSeam(sources, `verticals/${owner}/shared/api.ts`, owner, diagnostics),
    `${owner}\n${diagnostics.join('\n')}`,
  ).toBe(true);
};

const changedSource = (
  sources: ReadonlyMap<string, string>,
  file: string,
  change: (source: string) => string,
): ReadonlyMap<string, string> => {
  const source = sources.get(file);
  expect(source, file).toBeDefined();
  const changed = change(source ?? '');
  expect(changed, file).not.toBe(source);
  return new Map([...sources, [file, changed]]);
};

it.effect('accepts descriptor-authorized production search reads without a fifth positional callback', () =>
  Effect.gen(function* descriptorAuthorizedSearch() {
    for (const owner of [marketCatalogOwner, 'crm', 'party-registry']) {
      expectValidOwner(yield* loadOwnerSources(owner), owner);
    }
  }),
);

it.effect('accepts production shorthand read identities and immutable contribution-key aliases', () =>
  Effect.gen(function* immutableSearchIdentities() {
    for (const owner of [financeBillingOwner, 'legal-agreements', 'property-leasing', 'property-portfolio']) {
      expectValidOwner(yield* loadOwnerSources(owner), owner);
    }
  }),
);

it.effect('accepts native nested search layer provisions without bypassing the governed runtime', () =>
  Effect.gen(function* nativeSearchLayers() {
    for (const owner of ['facility-operations', 'sales-pipeline', workTasksOwner]) {
      expectValidOwner(yield* loadOwnerSources(owner), owner);
    }
  }),
);

it.effect('accepts the registered native media download read but not a write or search access kind', () =>
  Effect.gen(function* mediaDownloadRead() {
    const owner = 'merchandise';
    const sources = yield* loadOwnerSources(owner);
    const file = `verticals/${owner}/src/api/media.read.ts`;
    expectValidOwner(sources, owner);
    for (const access of ['write', 'search', 'unrestricted']) {
      expect(
        acceptsOwner(
          changedSource(sources, file, (source) => source.replace("accessKind: 'download'", `accessKind: '${access}'`)),
          owner,
        ),
        access,
      ).toBe(false);
    }
  }),
);

it.effect('rejects missing, fake, shadowed, mutated, or disconnected search collection authorization', () =>
  Effect.gen(function* invalidCollectionAuthorization() {
    const owner = marketCatalogOwner;
    const sources = yield* loadOwnerSources(owner);
    const file = `verticals/${owner}/src/search/markets.provider.ts`;
    expectValidOwner(sources, owner);
    const invalidChanges = [
      (source: string) =>
        source.replace(
          / {4}resultAuthorization: defineReadSearchCollectionAuthorization\(\{[\s\S]*?\n {4}\}\),\n/u,
          '',
        ),
      (source: string) =>
        source.replace('resultAuthorization: defineReadSearchCollectionAuthorization(', 'resultAuthorization: fake('),
      (source: string) =>
        `${source.replace('  defineReadSearchCollectionAuthorization,\n', '')}\nimport { defineReadSearchCollectionAuthorization } from './fake-native.ts';`,
      (source: string) => `${source}\nfunction shadow(defineReadSearchCollectionAuthorization: unknown) {}`,
      (source: string) => `${source}\ndefineReadSearchCollectionAuthorization = fake;`,
      (source: string) => `${source}\n({ defineReadSearchCollectionAuthorization } = attacker);`,
      (source: string) => source.replace('resource: (item) => item.ref,', 'resource: undefined,'),
      (source: string) =>
        source
          .replace(wholeMarketItems, 'items: (result: MarketsProviderResponse) => result.slice(0, 0),')
          .replace(authorizedItemsResult, 'withItems: (result, _items) => result,'),
      (source: string) => source.replace(wholeMarketItems, 'items: (result: MarketsProviderResponse) => [],'),
      (source: string) => source.replace('resource: (item) => item.ref,', 'resource: (item) => otherRef,'),
      (source: string) => source.replace(authorizedItemsResult, ''),
      (source: string) => source.replace(authorizedItemsResult, '...adapter,'),
      (source: string) =>
        source.replace(
          'resultSchema: MarketsProviderResponseSchema,\n      withItems:',
          'resultSchema: WrongResponseSchema,\n      withItems:',
        ),
      (source: string) =>
        source.replace(
          "  () => ({ kind: 'module', moduleId: moduleKey }),",
          "  () => ({ kind: 'module', moduleId: moduleKey }),\n  () => [],",
        ),
      (source: string) =>
        source.replace("  authorization: { kind: 'context_permission', permission: 'module.access' },\n", ''),
      (source: string) => source.replace("permission: 'module.access'", "permission: 'wrong.permission'"),
      (source: string) => source.replace("role: 'search'", "role: 'api'"),
      (source: string) => source.replace('owningModuleKey: moduleKey', "owningModuleKey: 'wrong.owner'"),
    ];
    for (const [index, change] of invalidChanges.entries()) {
      expect(acceptsOwner(changedSource(sources, file, change), owner), `collection control ${index}`).toBe(false);
    }
  }),
);

it.effect(
  'preserves the restricted owner-legal-entity authorization contract and rejects an extra result resolver',
  () =>
    Effect.gen(function* ownerLegalEntityAuthorization() {
      const owner = financeBillingOwner;
      const sources = yield* loadOwnerSources(owner);
      const file = `verticals/${owner}/src/search/documents.provider.ts`;
      expectValidOwner(sources, owner);
      for (const [before, after] of [
        ['requiredModuleAccess: true', 'requiredModuleAccess: false'],
        ["accessFiltering: 'legal_entity_scope'", "accessFiltering: 'tenant_scope'"],
        ["legalEntityScope: 'required'", "legalEntityScope: 'optional'"],
        ["permissionTarget: 'module'", "permissionTarget: 'tenant'"],
        ["permission: 'module.access'", "permission: 'other.permission'"],
        ['requiredModuleAccess: true,', 'requiredModuleAccess: true,\n      extra: true,'],
        ["permissionTarget: 'module',", "permissionTarget: 'module',\n    resourcePermission: fake,"],
        ["  () => ({ kind: 'module', moduleId }),", "  () => ({ kind: 'module', moduleId }),\n  () => [],"],
      ]) {
        expect(
          acceptsOwner(
            changedSource(sources, file, (source) => source.replace(before, after)),
            owner,
          ),
          before,
        ).toBe(false);
      }
    }),
);

it.effect('proves shorthand read identities only through immutable, unshadowed literal bindings', () =>
  Effect.gen(function* strictReadIdentityBindings() {
    for (const [owner, name, binding, value] of [
      [financeBillingOwner, 'documents', 'readKey', 'finance.billing.search.documents'],
      ['property-leasing', 'leases', 'owningModuleKey', 'property.leasing'],
    ]) {
      const sources = yield* loadOwnerSources(owner);
      const file = `verticals/${owner}/src/search/${name}.provider.ts`;
      const declaration = `const ${binding} = '${value}';`;
      expectValidOwner(sources, owner);
      for (const change of [
        (source: string) => source.replace(declaration, declaration.replace(';', ' as const;')),
        (source: string) => source.replace(new RegExp(`^(\\s*)${binding},`, 'mu'), `$1${binding}: ${binding},`),
        (source: string) => `${source}\nconst ordinaryRead = () => ${binding} === '${value}';`,
      ]) {
        expectValidOwner(changedSource(sources, file, change), owner);
      }
      for (const change of [
        (source: string) => source.replace(declaration, declaration.replace('const ', 'let ')),
        (source: string) => source.replace(declaration, `const ${binding} = 'wrong.owner';`),
        (source: string) => source.replace(declaration, `const ${binding} = getIdentity();`),
        (source: string) => `${source}\n${binding} = 'wrong.owner';`,
        (source: string) => `${source}\n${binding} += '.wrong';`,
        (source: string) => `${source}\n({ ${binding} } = attacker);`,
        (source: string) => `${source}\nfor (${binding} of attacker) {}`,
        (source: string) => `${source}\nfunction shadow(${binding}: string) {}`,
        (source: string) => `${source}\nfunction shadow({ ${binding} }: { ${binding}: string }) {}`,
        (source: string) => `${source}\n{ const ${binding} = 'wrong.owner'; }`,
        (source: string) => `${source}\ntry {} catch (${binding}) {}`,
      ]) {
        expect(acceptsOwner(changedSource(sources, file, change), owner), `${owner}: ${String(change)}`).toBe(false);
      }
    }
  }),
);

it.effect('rejects mutable, shadowed, or wrong contribution-key aliases in the owner manifest', () =>
  Effect.gen(function* strictManifestIdentityBindings() {
    const owner = workTasksOwner;
    const sources = yield* loadOwnerSources(owner);
    const file = `verticals/${owner}/vertical.manifest.ts`;
    const declaration = "const searchEntrypointKey = 'work.tasks.search.tasks';";
    expectValidOwner(sources, owner);
    expectValidOwner(
      changedSource(sources, file, (source) => source.replace(declaration, declaration.replace(';', ' as const;'))),
      owner,
    );
    for (const change of [
      (source: string) => source.replace(declaration, declaration.replace('const ', 'let ')),
      (source: string) => source.replace(declaration, "const searchEntrypointKey = 'other.owner.search.tasks';"),
      (source: string) => source.replace(declaration, "const searchEntrypointKey = 'work.tasks.search.' + 'tasks';"),
      (source: string) =>
        source.replace('contributionKey: searchEntrypointKey', "contributionKey: 'work.tasks.api.tasks'"),
      (source: string) => source.replace("role: 'search'", "role: 'api'"),
      (source: string) => `${source}\nsearchEntrypointKey = 'other.owner.search.tasks';`,
      (source: string) => `${source}\n({ searchEntrypointKey } = attacker);`,
      (source: string) => `${source}\nfunction shadow(searchEntrypointKey: string) {}`,
      (source: string) => `${source}\n{ const searchEntrypointKey = 'other.owner.search.tasks'; }`,
    ]) {
      expect(acceptsOwner(changedSource(sources, file, change), owner), String(change)).toBe(false);
    }
  }),
);

it.effect('requires native layer imports and keeps the governed runtime first in nested provisions', () =>
  Effect.gen(function* strictNativeProvisions() {
    const owner = workTasksOwner;
    const sources = yield* loadOwnerSources(owner);
    const file = `verticals/${owner}/api/index.ts`;
    const queryLayer = 'CoreSearchQueryRuntimeLive.pipe(GovernedReadLayer.provide(CoreSearchProjectionStoreLive))';
    expectValidOwner(sources, owner);
    for (const change of [
      (source: string) =>
        `${source.replace('Layer as GovernedReadLayer, ', '')}\nimport { Layer as GovernedReadLayer } from './fake-native.ts';`,
      (source: string) => `${source}\nfunction shadow(GovernedReadLayer: unknown) {}`,
      (source: string) => `${source}\nGovernedReadLayer.provide = fake;`,
      (source: string) => `${source}\n({ GovernedReadLayer } = attacker);`,
      (source: string) => `${source}\nObject.assign(GovernedReadLayer, { provide: fake });`,
      (source: string) => source.replace(queryLayer, 'makeQueryLayer()'),
      (source: string) => source.replace(queryLayer, `${queryLayer}.pipe(bypassGate)`),
      (source: string) =>
        source.replace(queryLayer, 'CoreSearchQueryRuntimeLive.pipe(FakeLayer.provide(CoreSearchProjectionStoreLive))'),
      (source: string) =>
        source.replace(
          queryLayer,
          'CoreSearchQueryRuntimeLive.pipe(GovernedReadLayer.provide(CoreSearchProjectionStoreLive, extra))',
        ),
      (source: string) =>
        source.replace(
          'tasksReadApiLive.pipe(\n    GovernedReadLayer.provide(governedReadRuntimeLive),',
          'tasksReadApiLive.pipe(',
        ),
      (source: string) =>
        source.replace(
          'tasksReadApiLive.pipe(\n    GovernedReadLayer.provide(governedReadRuntimeLive),',
          'tasksReadApiLive.pipe(\n    GovernedReadLayer.provide(fakeRuntime),',
        ),
      (source: string) => source.replace('tasksReadApiLive.pipe(\n', 'tasksReadApiLive.pipe(\n    bypassGate,\n'),
    ]) {
      expect(acceptsOwner(changedSource(sources, file, change), owner), String(change)).toBe(false);
    }
  }),
);

it.effect('permits a native Core-only Action problem mapper only when the registered domain schema is Never', () =>
  Effect.gen(function* coreOnlyActionProblems() {
    const owner = marketCatalogOwner;
    const sources = yield* loadOwnerSources(owner);
    const action = `verticals/${owner}/src/actions/request-search-rebuild.action.ts`;
    const problems = `verticals/${owner}/api/request-search-rebuild-action-problems.ts`;
    expectValidOwner(sources, owner);
    for (const [file, before, after] of [
      [action, 'domainErrorSchema: Schema.Never', 'domainErrorSchema: DomainErrorSchema'],
      [action, "import { Effect, Schema } from 'effect';", "import { Effect, Schema } from './fake-native.ts';"],
      [
        problems,
        'export const mapRequestSearchRebuildActionProblem = mapCoreProblem;',
        'export const mapRequestSearchRebuildActionProblem = fake;',
      ],
      [problems, "import { Match } from 'effect';", "import { Match } from './fake-native.ts';"],
      [problems, 'Match.exhaustive,', 'bypass,'],
      [
        action,
        coreOnlyDomainSchema,
        "domainErrorSchema: Schema.Never,\n    ['domainError' + 'Schema']: DomainErrorSchema,",
      ],
      [
        action,
        coreOnlyDomainSchema,
        'domainErrorSchema: Schema.Never,\n    ...{ domainErrorSchema: DomainErrorSchema },',
      ],
      [action, coreOnlyDomainSchema, 'domainErrorSchema: Schema.Never,\n    domainErrorSchema: DomainErrorSchema,'],
    ]) {
      expect(
        acceptsOwner(
          changedSource(sources, file, (source) => source.replace(before, after)),
          owner,
        ),
        before,
      ).toBe(false);
    }
    for (const tail of [
      'mapCoreProblem = fake;',
      '({ mapCoreProblem } = attacker);',
      'function shadow(mapCoreProblem: unknown) {}',
      'Match.tags = fake;',
      '({ Match } = attacker);',
    ]) {
      expect(
        acceptsOwner(
          changedSource(sources, problems, (source) => `${source}\n${tail}`),
          owner,
        ),
        tail,
      ).toBe(false);
    }
  }),
);
