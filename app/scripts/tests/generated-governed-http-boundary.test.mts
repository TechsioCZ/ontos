import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { hasCompleteGeneratedModuleApiSeam } from '../generated-governed-http-boundary.mts';

const coreReadHelperFile = 'packages/core-runtime/src/auth/assignable-principals.ts';
const aresReadName = 'ares-lookup';
const counterpartyReadName = 'counterparty-read';
const propertyLeasingOwner = 'property-leasing';
const legalAgreementsOwner = 'legal-agreements';
const shadowEffect = 'function shadow(Effect: unknown) {}';
const marketCatalogOwner = 'commerce-market-catalog';
const financeBillingOwner = 'finance-billing';
const workTasksOwner = 'work-tasks';
const marketPreparePhase = 'prepare: prepareMarkets,';
const loadPhasePrefix = 'load: (_input,';
const protectedAuthorization = "authorization: { kind: 'protected' }";
const financeScopedLoad = 'context.services.loadSearchStateRow()';
const mapUnavailable = 'Effect.mapError(unavailable)';
const scopedPersistenceCall = 'persistenceService(transaction, scope)';
const searchFactoryTail = '  makeSearchServices,\n);';
const coreOnlyDomainSchema = 'domainErrorSchema: Schema.Never,';
const partyRegistryOwner = 'party-registry';
const engagementReadName = 'organization-engagement-profile';
const partyDetailReadName = 'party-detail';
const correctionLookupArguments = 'transaction, scope.tenantId, correctionId';

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
  for (const file of ['packages/core-runtime/package.json', coreReadHelperFile]) {
    sources.set(file, yield* Effect.promise(() => readFile(path.join(root, file), 'utf-8')));
  }
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

const expectReadProof = (
  sources: ReadonlyMap<string, string>,
  owner: string,
  read: string,
  expected: boolean,
  context = '',
): void => {
  const diagnostics: string[] = [];
  hasCompleteGeneratedModuleApiSeam(sources, `verticals/${owner}/shared/api.ts`, owner, diagnostics);
  expect(
    diagnostics.some(
      (diagnostic) => diagnostic.startsWith(`${read}:`) || diagnostic.startsWith(`${read} publication:`),
    ),
    `${read} ${context}\n${diagnostics.join('\n')}`,
  ).toBe(!expected);
};

const expectPartyReadMutations = (
  sources: ReadonlyMap<string, string>,
  read: string,
  file: string,
  changes: readonly (readonly [string, string])[],
): void => {
  const owner = partyRegistryOwner;
  expectReadProof(sources, owner, read, true);
  for (const [before, after] of changes) {
    expectReadProof(
      changedSource(sources, `verticals/${owner}/${file}`, (source) => source.replaceAll(before, after)),
      owner,
      read,
      false,
      `${file}: ${before}`,
    );
  }
};

const expectPartyScopedDetailProofs = (sources: ReadonlyMap<string, string>): void => {
  expectPartyReadMutations(sources, 'party-correction', 'src/api/party-correction.read.ts', [
    ['input.correctionRef.resourceId', 'foreignRef.resourceId'],
    [correctionLookupArguments, 'transaction, correctionId, scope.tenantId'],
    [correctionLookupArguments, 'transaction, scope.tenantId'],
    [correctionLookupArguments, 'transaction, scope.tenantId, correctionId, correctionId'],
    ['context.services', 'foreign.services'],
    ['Effect.map(readDetailResult)', 'Effect.map(unknownResult)'],
  ]);
  expectPartyReadMutations(sources, 'party-correction', 'src/api/read-outcome.ts', [
    ["code: 'read_handler_unavailable', reason", "code: 'read_handler_unavailable', reason: foreignReason"],
    ["code: 'read_handler_not_found', reason", "code: 'read_handler_not_found', reason: foreignReason"],
    [
      "Match.tag('found', ({ value }) => Effect.succeed(value))",
      "Match.tag('found', ({ value }) => Effect.succeed(foreignValue))",
    ],
    ['resultCount: 1', 'resultCount: untrustedCount'],
  ]);
  expectPartyReadMutations(
    sources,
    'party-official-identifier-detail',
    'src/services/party-official-identifier-persistence.service.ts',
    [
      ['eq(partyOfficialIdentifiers.tenantId, tenantId)', 'eq(partyOfficialIdentifiers.tenantId, foreignTenant)'],
      [
        'eq(partyOfficialIdentifiers.officialIdentifierId, identifierId)',
        'eq(partyOfficialIdentifiers.officialIdentifierId, foreignId)',
      ],
    ],
  );
  expectPartyReadMutations(
    sources,
    'party-contact-point-detail',
    'src/services/party-contact-point-persistence.service.ts',
    [
      [
        'aliases: AliasOperations = transactionAliasService(transaction)',
        'aliases: AliasOperations = transactionAliasService(foreignTransaction)',
      ],
      ['const transactionAliasService = (transaction:', 'const transactionAliasService = (foreignTransaction:'],
      [
        'requireCanonicalPartyWriteTarget(transaction, tenantId, partyId)',
        'foreignAliasLoader(transaction, tenantId, partyId)',
      ],
    ],
  );
};

const expectPartyEngagementProofs = (sources: ReadonlyMap<string, string>): void => {
  expectPartyReadMutations(sources, engagementReadName, 'src/api/organization-engagement-profile.read.ts', [
    ['scope.legalEntityId === undefined', 'scope.legalEntityId !== undefined'],
    [
      'findOrganizationEngagementProfile(transaction, scope.tenantId, profileId)',
      'findOrganizationEngagementProfile(transaction, profileId, scope.tenantId)',
    ],
    ['find: (profileId)', 'find: (scope)'],
  ]);
  expectPartyReadMutations(sources, engagementReadName, 'src/services/engagement-profile-persistence.service.ts', [
    ['eq(table.tenantId, tenantId)', 'eq(table.tenantId, foreignTenant)'],
    ['profilePredicate(tenantId, profileId)', 'profilePredicate(profileId, tenantId)'],
    [
      '} = engagementProfilePersistence(organizationEngagementProfiles, organizationEngagementProfileFromRecord)',
      '} = foreignFactory(organizationEngagementProfiles, organizationEngagementProfileFromRecord)',
    ],
    [
      'find: findOrganizationEngagementProfile,',
      'find: findOrganizationEngagementProfile,\n  create: findOrganizationEngagementProfile,',
    ],
    ['const profilePredicate =', 'let profilePredicate ='],
    ['  return {\n    create:', '  toDto = foreignMapper;\n  return {\n    create:'],
  ]);
  for (const tail of [
    '\nfindOrganizationEngagementProfile = fake;',
    '\n({ findOrganizationEngagementProfile } = foreign);',
    '\nfunction shadow(engagementProfilePersistence: unknown) {}',
  ]) {
    expectReadProof(
      changedSource(
        sources,
        'verticals/party-registry/src/services/engagement-profile-persistence.service.ts',
        (source) => source + tail,
      ),
      partyRegistryOwner,
      engagementReadName,
      false,
    );
  }
};

const expectPartyAliasProofs = (sources: ReadonlyMap<string, string>): void => {
  expectPartyReadMutations(sources, partyDetailReadName, 'src/api/party-detail.read.ts', [
    ['requestedPartyRef.tenantId !== tenantId', 'requestedPartyRef.tenantId === tenantId'],
    ['services.resolve(requestedPartyRef.resourceId)', 'services.resolve(foreignRef.resourceId)'],
    ['services.find(resolved.canonicalPartyId)', 'services.find(requestedPartyRef.resourceId)'],
    ['.facts(resolved.canonicalPartyId, includeFactHistory)', '.facts(resolved.canonicalPartyId)'],
    ['.facts(resolved.canonicalPartyId, includeFactHistory)', '.facts(includeFactHistory, resolved.canonicalPartyId)'],
    ['findPartyRecord(transaction, scope.tenantId, partyId)', 'findPartyRecord(transaction, foreignTenant, partyId)'],
    ['context.scope.tenantId,\n        context.services', 'input.tenantId,\n        context.services'],
    ['PartyAliasResolutionCrossTenant: unavailable', 'PartyAliasResolutionCrossTenant: foreignMapper'],
    ['makePartyRef(tenantId, resolved.canonicalPartyId)', 'makePartyRef(foreignTenant, resolved.canonicalPartyId)'],
  ]);
  expectPartyReadMutations(sources, partyDetailReadName, 'src/merge/party-alias-resolution.service.ts', [
    [
      'makeTransactionPartyAliasResolutionService(transaction).resolvePartyAlias(tenantId, partyId)',
      'makeTransactionPartyAliasResolutionService(transaction).resolvePartyAlias(partyId, tenantId)',
    ],
    ['eq(partyAliases.tenantId, tenantId)', 'eq(partyAliases.tenantId, foreignTenant)'],
    ['makePartyAliasResolutionService({\n    findAlias:', 'foreignFactory({\n    findAlias:'],
  ]);
  expectPartyReadMutations(sources, partyDetailReadName, 'shared/domain/identity-contracts.ts', [
    [
      "resourceType: 'party.registry.party',\n  tenantId,",
      "resourceType: 'party.registry.party',\n  tenantId: foreignTenant,",
    ],
  ]);
};

const expectPartyOptionalReferenceProofs = (sources: ReadonlyMap<string, string>): void => {
  expectPartyReadMutations(sources, 'party-match-decision', 'src/api/party-match-decision.read.ts', [
    ['input.decisionRef.tenantId !== context.scope.tenantId', 'input.decisionRef.tenantId === context.scope.tenantId'],
    ['input.decisionRef.tenantId !== context.scope.tenantId', 'input.decisionRef.tenantId !== input.tenantId'],
    ['{ decisionId: input.decisionRef.resourceId }', '{ decisionId: foreignRef.resourceId }'],
    ['Schema.decodeEffect(PartyMatchDecisionResponseSchema)', 'Schema.decodeEffect(ForeignSchema)'],
    ['findMatchDecision(transaction, scope.tenantId, input)', 'findMatchDecision(transaction, input, scope.tenantId)'],
    ['context.services', 'foreign.services'],
  ]);
  expectPartyReadMutations(sources, 'party-match-decision', 'shared/resources/timeline-resource.ts', [
    [
      '    resourceId,\n    resourceType,\n    tenantId,',
      '    resourceId,\n    resourceType,\n    tenantId: foreignTenant,',
    ],
    ['const makeRef =', 'let makeRef ='],
    ['  const resourceType =', '  slug = foreignSlug;\n  const resourceType ='],
  ]);
};

const expectPartyPurposeRuntimeProofs = (sources: ReadonlyMap<string, string>): void => {
  expectPartyReadMutations(sources, 'crm-client-intake-review', 'api/index.ts', [
    ['GovernedReadLayer.provide(governedActionRuntimeLive)', 'GovernedReadLayer.provide(foreignRuntime)'],
    [
      'actionRuntime: Layer.Layer<ActionRuntime | OwnerActionApprovals,',
      'actionRuntime: Layer.Layer<ReadRuntime | OwnerActionApprovals,',
    ],
    ['  productionActionRuntimeLive,\n', '  productionReadRuntimeLive,\n'],
  ]);
};

it.effect('accepts descriptor-authorized production search reads without a fifth positional callback', () =>
  Effect.gen(function* descriptorAuthorizedSearch() {
    for (const owner of [marketCatalogOwner, 'crm']) {
      expectValidOwner(yield* loadOwnerSources(owner), owner);
    }
    const owner = partyRegistryOwner;
    const sources = yield* loadOwnerSources(owner);
    const file = `verticals/${owner}/src/api/ares-lookup.read.ts`;
    expectReadProof(sources, owner, aresReadName, true);
    expectReadProof(sources, owner, counterpartyReadName, true);
    for (const [before, after] of [
      ['service.subject({', 'foreign.subject({'],
      ['service.subject({', 'service.unregisteredMethod({'],
      ['correlationId: context.scope.correlationId', 'correlationId: input.correlationId'],
      ['ico: input.ico', 'ico: context.scope.ico'],
      ['Effect.catch(mapAresFailure)', 'Effect.catch(unknownMapper)'],
      ['AresSubjectService.pipe(', 'ForeignService.pipe('],
    ]) {
      expectReadProof(
        changedSource(sources, file, (source) => source.replace(before ?? '', after ?? '')),
        owner,
        aresReadName,
        false,
      );
    }
    for (const tail of ['AresSubjectService = fake;', 'mapAresFailure = fake;', 'try {} catch (mapAresFailure) {}']) {
      expectReadProof(
        changedSource(sources, file, (source) => `${source}\n${tail}`),
        owner,
        aresReadName,
        false,
      );
    }
    const service = `verticals/${owner}/src/integrations/ares/ares-subject.service.ts`;
    for (const tail of [
      'function shadow(Context: unknown) {}',
      'Context.Service = fake;',
      'AresSubjectServiceLive = fake;',
    ]) {
      expectReadProof(
        changedSource(sources, service, (source) => `${source}\n${tail}`),
        owner,
        aresReadName,
        false,
      );
    }
    const lookup = `verticals/${owner}/src/api/counterparty-read.read.ts`;
    for (const [before, after] of [
      ['input.counterpartyRef,\n        context.scope.tenantId', 'foreignRef,\n        context.scope.tenantId'],
      ['context.scope.tenantId,\n        context.services.find', 'input.tenantId,\n        context.services.find'],
      ['context.services.find,', 'context.services.other,'],
      [
        'transaction, scope.tenantId, scope.legalEntityId, counterpartyId',
        'transaction, scope.legalEntityId, scope.tenantId, counterpartyId',
      ],
      [
        'transaction, scope.tenantId, scope.legalEntityId, counterpartyId',
        'transaction, scope.tenantId, counterpartyId',
      ],
      ['findCounterpartyRecord(transaction,', 'unknownLoader(transaction,'],
      ['find: (counterpartyId: string) =>', 'find: (scope: string) =>'],
      ['Effect.map((value) => ({ evidence: { resultCount: 1 }, result: value }))', 'Effect.map(foreignMapper)'],
      ['result: value', 'result: foreignValue'],
    ]) {
      expectReadProof(
        changedSource(sources, lookup, (source) => source.replace(before ?? '', after ?? '')),
        owner,
        counterpartyReadName,
        false,
      );
    }
    const helper = `verticals/${owner}/src/api/counterparty-read-support.ts`;
    for (const [before, after] of [
      ['ref.tenantId === tenantId', 'ref.tenantId === foreignTenant'],
      ['ref.tenantId === tenantId', 'ref.tenantId !== tenantId'],
      ['load(ref.resourceId)', 'load(foreignRef.resourceId)'],
      ['load(ref.resourceId)', 'foreignLoader(ref.resourceId)'],
      ['Effect.mapError((cause)', 'ForeignEffect.mapError((cause)'],
      ['reason: unavailableReason', 'reason: foreignReason'],
    ]) {
      expectReadProof(
        changedSource(sources, helper, (source) => source.replace(before ?? '', after ?? '')),
        owner,
        counterpartyReadName,
        false,
      );
    }
    expectPartyScopedDetailProofs(sources);
    expectPartyEngagementProofs(sources);
    expectPartyAliasProofs(sources);
    expectPartyOptionalReferenceProofs(sources);
    expectPartyPurposeRuntimeProofs(sources);
    expectValidOwner(sources, owner);
  }),
);

it.effect('accepts production shorthand read identities and immutable contribution-key aliases', () =>
  Effect.gen(function* immutableSearchIdentities() {
    for (const owner of [financeBillingOwner, legalAgreementsOwner, propertyLeasingOwner, 'property-portfolio']) {
      expectValidOwner(yield* loadOwnerSources(owner), owner);
    }
    const owner = 'property-portfolio';
    const sources = yield* loadOwnerSources(owner);
    const provider = `verticals/${owner}/src/search/assets.provider.ts`;
    for (const [before, after] of [
      [
        'prepareOwnerSearch(context.listAccess, context.deniedFieldPaths)',
        'prepareOwnerSearch(context.listAccess, undefined)',
      ],
      [
        'prepareOwnerSearch(context.listAccess, context.deniedFieldPaths)',
        'prepareOwnerSearch(context.deniedFieldPaths, context.listAccess)',
      ],
      ['context.services.load()', 'foreign.services.load()'],
      ['persistenceService(transaction, scope)', 'persistenceService(transaction, foreignScope)'],
    ]) {
      expect(
        acceptsOwner(
          changedSource(sources, provider, (source) => source.replace(before ?? '', after ?? '')),
          owner,
        ),
        before,
      ).toBe(false);
    }
    const helper = `verticals/${owner}/src/search/search-read.ts`;
    for (const [before, after] of [
      ["onExcessProperty: 'error'", "onExcessProperty: 'ignore'"],
      ['if (fields.length !== 0)', 'if (fields.length === 0)'],
      ['return predicate;', 'return untrustedPredicate;'],
      ['Schema.NonEmptyArray(ListAccessConditionSchema)', 'Schema.Array(ListAccessConditionSchema)'],
    ]) {
      expect(
        acceptsOwner(
          changedSource(sources, helper, (source) => source.replace(before ?? '', after ?? '')),
          owner,
        ),
        before,
      ).toBe(false);
    }
  }),
);

it.effect('accepts native nested search layer provisions without bypassing the governed runtime', () =>
  Effect.gen(function* nativeSearchLayers() {
    for (const owner of ['facility-operations', 'sales-pipeline', workTasksOwner]) {
      expectValidOwner(yield* loadOwnerSources(owner), owner);
    }
    const owner = 'sales-pipeline';
    const sources = yield* loadOwnerSources(owner);
    const file = `verticals/${owner}/src/services/search-record-access.ts`;
    const original = 'loadPipelineSearchRecords(transaction, scope, predicate)';
    for (const changed of [
      'loadPipelineSearchRecords(scope, transaction, predicate)',
      'loadPipelineSearchRecords(transaction, scope, undefined)',
      'loadPipelineSearchRecords(transaction, scope, predicate, predicate)',
      'loadPipelineSearchRecords(transaction, untrustedScope, predicate)',
    ]) {
      expect(
        acceptsOwner(
          changedSource(sources, file, (source) => source.replace(original, changed)),
          owner,
        ),
        changed,
      ).toBe(false);
    }
    for (const statement of [
      'scope = foreignScope;',
      'transaction = foreignTransaction;',
      'predicate = foreignPredicate;',
      '({ predicate } = attacker);',
    ]) {
      expect(
        acceptsOwner(
          changedSource(sources, file, (source) =>
            source.replace(
              'load: (predicate) => loadPipelineSearchRecords(transaction, scope, predicate)',
              `load: (predicate) => { ${statement} return loadPipelineSearchRecords(transaction, scope, predicate); }`,
            ),
          ),
          owner,
        ),
        statement,
      ).toBe(false);
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

it.effect('rejects missing phases, forged LIST forwarding, or disconnected canonical search provenance', () =>
  Effect.gen(function* invalidCanonicalSearchPhases() {
    const owner = marketCatalogOwner;
    const sources = yield* loadOwnerSources(owner);
    const file = `verticals/${owner}/src/search/markets.provider.ts`;
    expectValidOwner(sources, owner);
    const listForwarding = 'loadMarkets(context.scope, input, { listAccess: context.listAccess })';
    const invalidChanges = [
      (source: string) => source.replace(marketPreparePhase, 'prepare: fake,'),
      (source: string) => source.replace(marketPreparePhase, 'prepare: undefined,'),
      (source: string) => source.replace(loadPhasePrefix, 'unknownPhase: (_input,'),
      (source: string) => source.replace(marketPreparePhase, '...unknownPhases,\n    prepare: prepareMarkets,'),
      (source: string) => source.replace(marketPreparePhase, 'prepare: fake,\n    prepare: prepareMarkets,'),
      (source: string) => source.replace('context: ReadPrepareContext', 'context: unknown'),
      (source: string) => source.replace(listForwarding, 'loadMarkets(context.scope, input, {})'),
      (source: string) =>
        source.replace(listForwarding, 'loadMarkets(context.scope, input, { listAccess: unrestricted })'),
      (source: string) =>
        source.replace(listForwarding, 'loadMarkets(untrustedScope, input, { listAccess: context.listAccess })'),
      (source: string) =>
        source.replace(listForwarding, 'unboundLoader(context.scope, input, { listAccess: context.listAccess })'),
      (source: string) => `${source}\nprepareMarkets = fake;`,
      (source: string) => `${source}\nloadMarkets = fake;`,
      (source: string) => `${source}\n({ loadMarkets } = attacker);`,
      (source: string) => `${source}\nfunction shadow(ReadPrepareContext: unknown) {}`,
      (source: string) => `${source}\nfunction shadow(Effect: unknown) {}`,
      (source: string) => source.replace("from 'effect'", "from './fake-native.ts'"),
      (source: string) =>
        source.replace('resultSchema: MarketsProviderResponseSchema,', 'resultSchema: WrongResponseSchema,'),
      (source: string) => source.replace(protectedAuthorization, "authorization: { kind: 'unknown' }"),
      (source: string) => source.replace("accessKind: 'search'", "accessKind: 'detail'"),
      (source: string) => source.replace("role: 'search'", "role: 'api'"),
      (source: string) => source.replace('owningModuleKey: moduleKey', "owningModuleKey: 'wrong.owner'"),
    ];
    for (const [index, change] of invalidChanges.entries()) {
      expect(acceptsOwner(changedSource(sources, file, change), owner), `canonical LIST control ${index}`).toBe(false);
    }
  }),
);

it.effect('preserves the scope-wide Finance gate, owner currentness, and genuine scoped native load phases', () =>
  Effect.gen(function* scopedFinanceSearch() {
    const owner = financeBillingOwner;
    const sources = yield* loadOwnerSources(owner);
    const file = `verticals/${owner}/src/search/documents.provider.ts`;
    expectValidOwner(sources, owner);
    const provider = sources.get(file);
    expect(provider).toContain("key: 'finance.billing.search-documents.read'");
    expect(provider).toContain('selectors: []');
    expect(provider).toContain(protectedAuthorization);
    expect(provider).toContain("legalEntityScope: 'required'");
    expect(provider).toContain('decodeFinanceState(context.loaded, context.scope)');
    expect(provider).toContain('projectFinanceRecords(state, revision, {}).state');
    expect(provider).toMatch(
      /loadCurrentSearchHits\(\s*context\.scope,\s*'finance\.billing\.document',\s*\{[^}]+\},\s*visible,/u,
    );
    const persistence = sources.get(`verticals/${owner}/src/services/finance-state-repository.ts`);
    expect(persistence).toContain('transaction.scope.tenantId !== scope.tenantId');
    expect(persistence).toContain('transaction.scope.legalEntityId !== legalEntityId');
    expect(persistence).toContain(
      'and(eq(financeStates.tenantId, scope.tenantId), eq(financeStates.legalEntityId, legalEntityId))',
    );
    expect(persistence).toContain('row.tenantId !== scope.tenantId || row.legalEntityId !== legalEntityId');
    const projection = sources.get(`verticals/${owner}/src/services/search-projection.ts`);
    for (const guard of [
      'document === undefined',
      'hit.archived',
      'hit.ref.moduleId !== moduleId',
      'hit.ref.resourceType !== resourceType',
      'hit.ref.tenantId !== scope.tenantId',
      'hit.selectedLegalEntityId !== legalEntityId',
      '!matchesCoreSearchValues([document.title, ...document.searchableText], parsedQuery.tokens)',
    ]) {
      expect(projection, guard).toContain(guard);
    }
    for (const [before, after] of [
      [protectedAuthorization, "authorization: { kind: 'unknown' }"],
      ["legalEntityScope: 'required'", "legalEntityScope: 'tenant_scope'"],
      [loadPhasePrefix, 'unknownPhase: (_input,'],
      [loadPhasePrefix, '...unknownPhases,\n    load: (_input,'],
      [loadPhasePrefix, 'load: fake,\n    load: (_input,'],
      ['ReadLoadContext<SearchServices>', 'ForeignLoadContext<SearchServices>'],
      [financeScopedLoad, 'other.services.loadSearchStateRow()'],
      [financeScopedLoad, 'context.service.loadSearchStateRow()'],
      [financeScopedLoad, 'loadSearchStateRow()'],
      [financeScopedLoad, 'context.services.loadSearchStateRow(_input)'],
      [financeScopedLoad, 'context.services.loadSearchStateRow(context.scope)'],
      [financeScopedLoad, 'context.services.loadSearchStateRow().pipe(bypass)'],
      [mapUnavailable, 'Effect.mapError(unknownMapper)'],
      [mapUnavailable, 'OtherEffect.mapError(unavailable)'],
      [mapUnavailable, 'Effect.mapError(unavailable, bypass)'],
      [mapUnavailable, 'Effect.mapError(unavailable), bypass'],
      [scopedPersistenceCall, 'persistenceService(transaction, wrongScope)'],
      [scopedPersistenceCall, 'persistenceService(wrongTransaction, scope)'],
      [scopedPersistenceCall, 'Effect.succeed({})'],
      [searchFactoryTail, '  undefined,\n);'],
      [searchFactoryTail, '  unknownFactory,\n);'],
      [searchFactoryTail, '  makeSearchServices,\n  () => [],\n);'],
      ["from '../services/finance-state-repository.ts'", "from '../services/foreign-factory.ts'"],
      ["from '@app/core-runtime'", "from './foreign-core.ts'"],
      ["from 'effect'", "from './foreign-effect.ts'"],
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
      'Effect.mapError = bypass;',
      'Object.assign(Effect, { mapError: bypass });',
      shadowEffect,
      'function shadow(ReadLoadContext: unknown) {}',
      'function shadow(ReadServiceFactory: unknown) {}',
      'function shadow(persistenceService: unknown) {}',
      'persistenceService = fake;',
      'makeSearchServices = fake;',
      'unavailable = fake;',
      '({ unavailable } = attacker);',
    ]) {
      expect(
        acceptsOwner(
          changedSource(sources, file, (source) => `${source}\n${tail}`),
          owner,
        ),
        tail,
      ).toBe(false);
    }
    const factoryFile = `verticals/${owner}/src/services/finance-state-repository.ts`;
    for (const [before, after] of [
      ['Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0]', 'UnknownTransaction'],
      ['scope: OperationalScope', 'scope: ForeignScope'],
      ["from '@app/core-runtime'", "from './foreign-core.ts'"],
    ]) {
      expect(
        acceptsOwner(
          changedSource(sources, factoryFile, (source) => source.replace(before, after)),
          owner,
        ),
        before,
      ).toBe(false);
    }
    for (const tail of [
      'persistenceService = fake;',
      'function shadow(ReadServiceFactory: unknown) {}',
      'function shadow(OperationalScope: unknown) {}',
      'type Transaction = UnknownTransaction;',
    ]) {
      expect(
        acceptsOwner(
          changedSource(sources, factoryFile, (source) => `${source}\n${tail}`),
          owner,
        ),
        tail,
      ).toBe(false);
    }
  }),
);

it.effect('proves shorthand read identities only through immutable, unshadowed literal bindings', () =>
  Effect.gen(function* strictReadIdentityBindings() {
    for (const [owner, name, binding, value] of [
      [financeBillingOwner, 'documents', 'readKey', 'finance.billing.search.documents'],
      [propertyLeasingOwner, 'leases', 'owningModuleKey', 'property.leasing'],
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

it.effect('rejects mutable, shadowed, or wrong contribution-key aliases in the owner runtime declaration', () =>
  Effect.gen(function* strictManifestIdentityBindings() {
    const owner = workTasksOwner;
    const sources = yield* loadOwnerSources(owner);
    // The split owner authors its shell contributions and their identity constants in the runtime declaration.
    const file = `verticals/${owner}/vertical.runtime-declaration.ts`;
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
    const marketSources = yield* loadOwnerSources(marketCatalogOwner);
    const marketRoot = `verticals/${marketCatalogOwner}/api/index.ts`;
    expectValidOwner(marketSources, marketCatalogOwner);
    const gateMerge = 'Layer.mergeAll(readRuntime, administrationAuthority)';
    for (const [before, after] of [
      [gateMerge, 'Layer.mergeAll(readRuntime, foreignAuthority)'],
      [gateMerge, 'Layer.mergeAll(administrationAuthority, readRuntime)'],
      [gateMerge, 'Layer.mergeAll(readRuntime, administrationAuthority, administrationAuthority)'],
      [gateMerge, 'Layer.mergeAll(readRuntime, administrationAuthority).pipe(Layer.provide(foreignAuthority))'],
      ['administrationAuthority: Layer.Layer<AccessDecisionGate,', 'administrationAuthority: Layer.Layer<ReadRuntime,'],
      ['AccessDecisionLive.pipe(', 'ForeignDecisionLive.pipe('],
      ["from '@app/core-runtime/access/enforcement'", "from './foreign-enforcement.ts'"],
      ['  AccessDecisionGate,', '  ForeignDecisionGate as AccessDecisionGate,'],
      ['  CoreSearchQueryRuntime,', '  ForeignQueryRuntime as CoreSearchQueryRuntime,'],
    ]) {
      expect(
        acceptsOwner(
          changedSource(marketSources, marketRoot, (source) => source.replace(before ?? '', after ?? '')),
          marketCatalogOwner,
        ),
        before,
      ).toBe(false);
    }
    for (const tail of [
      'productionReadRuntimeLive = fake;',
      'accessEnforcementLive = fake;',
      'function shadow(AccessDecisionGate: unknown) {}',
      'function shadow(Layer: unknown) {}',
    ]) {
      expect(
        acceptsOwner(
          changedSource(marketSources, marketRoot, (source) => `${source}\n${tail}`),
          marketCatalogOwner,
        ),
        tail,
      ).toBe(false);
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

const nativePhaseControls = [
  {
    changes: [
      ['financeWriteCapability(context.scope)', 'financeWriteCapability(untrustedScope)'],
      ['Effect.all(', 'ForeignEffect.all('],
      ['context.services.loadStateRow()', 'foreign.services.loadStateRow()'],
      [scopedPersistenceCall, 'Effect.succeed({})'],
    ],
    file: 'src/api/records.read.ts',
    owner: financeBillingOwner,
    tails: ['financeWriteCapability = fake;', shadowEffect],
  },
  {
    changes: [
      ['crmRecordsGrants(context.scope)', 'crmRecordsGrants(untrustedScope)'],
      ['context.prepared, {}, [', 'context.scope, {}, ['],
      ['persistenceService(transaction, { scope })', 'persistenceService(transaction, { scope: untrustedScope })'],
    ],
    file: 'src/api/agent-review.read.ts',
    owner: 'crm',
    tails: ['crmRecordsGrants = fake;', '({ persistenceService } = attacker);'],
  },
  {
    changes: [
      ['prepareTaskSearch(context.scope, context.listAccess)', 'prepareTaskSearch(context.scope, undefined)'],
      ['context.services.load(input, context.prepared)', 'context.services.load(input, context.scope)'],
      ['loadSearch(scope, input.query, listAccess)', 'loadSearch(untrustedScope, input.query, listAccess)'],
    ],
    file: 'src/search/tasks.provider.ts',
    owner: workTasksOwner,
    tails: ['prepareTaskSearch = fake;', 'function shadow(ReadLoadContext: unknown) {}'],
  },
  {
    changes: [
      [
        'prepareFacilitySearch(context.scope, context.listAccess)',
        'prepareFacilitySearch(context.scope, context.prepared)',
      ],
      ['context.services.load(context.prepared, false)', 'context.services.load(context.scope, false)'],
      ["makeFacilitySearchServices('asset')", "unboundFactory('asset')"],
      ["from './record-access.ts'", "from './foreign-factory.ts'"],
    ],
    file: 'src/search/assets.provider.ts',
    owner: 'facility-operations',
    tails: ['({ prepareFacilitySearch } = attacker);', 'makeFacilitySearchServices = fake;'],
  },
  {
    changes: [
      ['requireSearchFields(context.deniedFieldPaths)', 'requireSearchFields(undefined)'],
      ['requireSearchPredicate(context.listAccess)', 'requireSearchPredicate(undefined)'],
      [mapUnavailable, 'OtherEffect.mapError(unavailable)'],
    ],
    file: 'src/search/contracts.provider.ts',
    owner: legalAgreementsOwner,
    tails: ['requireSearchFields = fake;', 'requireSearchPredicate = fake;'],
  },
  {
    changes: [
      ['occupancyWriteCapability(context.scope)', 'occupancyWriteCapability(untrustedScope)'],
      ['Effect.succeed(false)', 'Effect.succeed(true)'],
      ["from './records.read.ts'", "from './foreign-capability.ts'"],
    ],
    file: 'src/api/agent-review.read.ts',
    owner: propertyLeasingOwner,
    tails: ['occupancyWriteCapability = fake;', '({ reviewsLiveProposals } = attacker);'],
  },
  {
    changes: [
      ['context.transaction((transaction)', 'foreign.transaction((transaction)'],
      [
        "loadCurrentMerchandiseSearch(transaction, context.scope, 'order', ids, context.prepared)",
        "loadCurrentMerchandiseSearch(transaction, context.scope, 'order', ids, undefined)",
      ],
      ['prepareSearchPredicate(context.listAccess)', 'prepareSearchPredicate(undefined)'],
      ['load: () => Effect.void', 'load: () => unknownEffect'],
      ["loadMerchandiseSearch(context.scope, 'order'", "loadMerchandiseSearch(context.scope, 'product'"],
    ],
    file: 'src/search/orders.provider.ts',
    owner: 'merchandise',
    tails: ['loadCurrentMerchandiseSearch = fake;', 'function shadow(ReadFinishContext: unknown) {}'],
  },
] as const;

for (const control of nativePhaseControls) {
  it.effect(`proves ${control.owner} native phases only with the original scope, callbacks, and factory`, () =>
    Effect.gen(function* nativePhaseProvenance() {
      const sources = yield* loadOwnerSources(control.owner);
      const file = `verticals/${control.owner}/${control.file}`;
      expectValidOwner(sources, control.owner);
      for (const [before, after] of control.changes) {
        expect(
          acceptsOwner(
            changedSource(sources, file, (source) => source.replace(before, after)),
            control.owner,
          ),
          `${control.owner}: ${before}`,
        ).toBe(false);
      }
      for (const tail of control.tails) {
        expect(
          acceptsOwner(
            changedSource(sources, file, (source) => `${source}\n${tail}`),
            control.owner,
          ),
          `${control.owner}: ${tail}`,
        ).toBe(false);
      }
      if (control.owner === 'merchandise') {
        const records = `verticals/${control.owner}/src/api/records.read.ts`;
        for (const [before, after] of [
          ['akrosServiceKeyGuard(input, context.scope)', 'akrosServiceKeyGuard(input, untrustedScope)'],
          [
            'context.scope.authMethod, context.scope.legalEntityId, input',
            'context.scope.legalEntityId, context.scope.authMethod, input',
          ],
          [
            'context.scope.authMethod, context.scope.legalEntityId, input',
            'context.scope.authMethod, input.legalEntityId, input',
          ],
          ['context.prepared)', 'undefined)'],
        ]) {
          expect(
            acceptsOwner(
              changedSource(sources, records, (source) => source.replace(before ?? '', after ?? '')),
              control.owner,
            ),
            before,
          ).toBe(false);
        }
      }
    }),
  );
}

it.effect('proves public Core read helper identity through its exact package export and original native wrapper', () =>
  Effect.gen(function* publicCoreReadProvenance() {
    const owner = 'crm';
    const sources = yield* loadOwnerSources(owner);
    expectValidOwner(sources, owner);
    for (const [file, before, after] of [
      [
        'packages/core-runtime/package.json',
        '"./auth/assignable-principals": "./src/auth/assignable-principals.ts"',
        '"./auth/assignable-principals": "./src/auth/foreign-principals.ts"',
      ],
      [coreReadHelperFile, 'export const readAssignablePrincipals =', 'const readAssignablePrincipals ='],
      [
        'verticals/crm/src/api/records.read.ts',
        "from '@app/core-runtime/auth/assignable-principals'",
        "from '@app/unreviewed/read-helper'",
      ],
    ]) {
      expect(
        acceptsOwner(
          changedSource(sources, file ?? '', (source) => source.replace(before ?? '', after ?? '')),
          owner,
        ),
        before,
      ).toBe(false);
    }
    const file = coreReadHelperFile;
    for (const tail of [
      'withGate = fake;',
      'readAssignablePrincipals = fake;',
      shadowEffect,
      '({ withGate } = attacker);',
    ]) {
      expect(
        acceptsOwner(
          changedSource(sources, file, (source) => `${source}\n${tail}`),
          owner,
        ),
        tail,
      ).toBe(false);
    }
  }),
);
