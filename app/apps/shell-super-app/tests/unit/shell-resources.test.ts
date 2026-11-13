import type { ApplicationCompositionModule, TenantModuleState } from '@app/core-runtime';
import { ReadPermissionDenied } from '@app/core-runtime';
import { makeAccessDecisionService } from '@app/core-runtime/access/enforcement';
import { DateTime, Duration, Effect, Fiber, Logger, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { makeInstalledModuleCatalogLoader } from '../../api/modules/installed-module-catalog.ts';
import {
  attachShellMedia,
  makeShellResourceDetail,
  makeShellSearch,
  ResourceRefSchema,
  ShellProviderUnavailableError,
  ShellTimelineEntrySchema,
} from '../../api/modules/shell-resources.ts';
import type { ShellProviderAssertionIssuer } from '../../api/modules/shell-resources.ts';
import type { ShellAccessGate } from '../../api/modules/shell-access-decisions.ts';
import { makeModuleSearchProviderGateway } from '../../api/modules/shell-search-provider-gateway.ts';
import {
  SHELL_SEARCH_PROVIDER_DEADLINE_MILLIS,
  SHELL_SEARCH_REQUEST_BUDGET_MILLIS,
} from '../../api/modules/shell-governed-search.ts';
import {
  cell,
  makeAuthority,
  makeCheck,
  person,
  principalHolder,
  tenant,
} from '../../../../packages/core-runtime/tests/unit/access-decision-support.ts';
import { makeShellTestAccessGate, shellTestScope } from '../support/access-decision-double.ts';
import type { ShellTestAccess } from '../support/access-decision-double.ts';

const moduleId = 'property.registry';
const resourceType = 'property.registry.unit';
const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const context = shellTestScope({ legalEntityId, principalId, tenantId });
const tenantContext = shellTestScope({ principalId, tenantId });
const ref = Schema.decodeUnknownSync(ResourceRefSchema)({
  moduleId,
  resourceId: 'unit-1',
  resourceType,
});
const resourceHit = {
  ref: { ...ref, tenantId },
  selectedLegalEntityId: legalEntityId,
  title: 'Unit 1',
};

/** One protected contribution carrier; the key must be `<moduleKey>.<resource>.<verb>`. */
const declaration = (key: string, kind: 'action' | 'read' = 'read') => ({
  key,
  kind,
  modes: ['run'] as const,
  placement: { group: 'unit', level: 'basic' as const },
  risk: 'routine' as const,
  selectors: [],
});

const entrypoint = (role: 'api' | 'search', access: 'read' | 'write' = 'read') => ({
  access,
  authorization: { kind: 'protected' as const },
  entrypointKey: `${moduleId}.${role}.${access}`,
  moduleKey: moduleId,
  role,
  scope: 'tenant' as const,
});

const RESOURCE_DETAIL_KEY = 'property.registry.resource.open';
const SEARCH_KEY = 'property.registry.unit.search';
const TIMELINE_KEY = 'property.registry.timeline.open';

const propertyContract = {
  deployment: { appId: 'property-registry', buildMarker: 'test' },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates: ['inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'],
    },
    module: {
      description: 'Property capability.',
      displayName: 'Property',
      id: moduleId,
      implementedAs: 'ultramodern_microvertical',
      kind: 'business_module',
    },
    publicSurface: {
      actions: [
        {
          accessDeclaration: declaration('property.registry.media.attach', 'action'),
          actionKey: 'property.registry.attach-media',
          auditProfile: 'standard',
          entrypoint: {
            access: 'write',
            authorization: { kind: 'protected' },
            entrypointKey: 'property.registry.attach-media',
            moduleKey: moduleId,
            role: 'action',
            scope: 'tenant',
          },
          idempotency: 'required',
          legalEntityScope: 'required',
          owningModuleId: moduleId,
          schemaVersion: '1',
        },
      ],
      api: [
        {
          key: 'property.registry.resource-api',
          operationKeys: ['detail'],
        },
      ],
      components: [],
      events: [],
      reports: [],
      resourceTypes: [
        {
          capabilities: {
            graphVisible: false,
            linkable: true,
            mediaAttachable: true,
            searchable: true,
            timelineVisible: true,
          },
          description: 'A unit.',
          key: resourceType,
          label: 'Unit',
          owningModuleId: moduleId,
        },
      ],
      search: [
        {
          accessFiltering: 'resource_permission',
          key: 'property.registry.unit-search',
          legalEntityScope: 'required',
          owningModuleId: moduleId,
          resourceType,
        },
      ],
      shellContributions: {
        mediaAttachments: [
          {
            accessDeclaration: declaration('property.registry.media.attach', 'action'),
            actionKey: 'property.registry.attach-media',
            apiKey: 'property.registry.resource-api',
            contributionKey: 'property.registry.media.unit',
            entrypoint: entrypoint('api', 'write'),
            resourceType,
          },
        ],
        navigation: [],
        pages: [],
        publicComponents: [],
        reports: [],
        resourceDetails: [
          {
            accessDeclaration: declaration(RESOURCE_DETAIL_KEY),
            apiKey: 'property.registry.resource-api',
            contributionKey: 'property.registry.resource.unit',
            entrypoint: entrypoint('api'),
            resourceType,
          },
        ],
        search: [
          {
            accessDeclaration: declaration(SEARCH_KEY),
            contributionKey: 'property.registry.search.unit',
            entrypoint: entrypoint('search'),
            searchKey: 'property.registry.unit-search',
          },
        ],
        timelines: [
          {
            accessDeclaration: declaration('property.registry.timeline.open'),
            apiKey: 'property.registry.resource-api',
            contributionKey: 'property.registry.timeline.unit',
            entrypoint: entrypoint('api'),
            resourceType,
          },
        ],
      },
    },
  },
  runtime: { outboxSubscriptions: [] },
  schemaVersion: '2',
};

const catalog = () => makeInstalledModuleCatalogLoader(makeCompositionSnapshot([propertyContract]));

/** The inventory a governed search answers with when its admitted owners declare no presentation bindings. */
const emptyPresentation = {
  business: { compositionRevision: expect.stringMatching(/^[\da-f]{64}$/u), entries: [], schemaVersion: '1' },
  pages: [],
};

const dependencies = (input: {
  readonly access: ShellTestAccess;
  readonly extraAnswers?: Readonly<Record<string, ShellTestAccess>>;
  readonly state?: TenantModuleState;
}) => {
  let assertion = 0;
  const state = input.state ?? 'active';
  return {
    access: makeShellTestAccessGate({
      answers: { [RESOURCE_DETAIL_KEY]: input.access, [SEARCH_KEY]: input.access, ...input.extraAnswers },
    }),
    catalog: catalog(),
    issueAssertion: () => {
      const authorization = `Bearer test-${assertion}`;
      assertion += 1;
      return Effect.succeed(authorization);
    },
    moduleStates: {
      getTenantModuleStates: (_tenantId: string, moduleIds: readonly string[]) =>
        Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state }))),
    },
  };
};

/** One resource reference as a provider returns it on the wire: plain ids the Shell decodes itself. */
interface ProviderResourceRef {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId?: string;
}

/** One counterparty result a search provider may return; the Shell decodes it at its own boundary. */
interface CounterpartyProviderResult {
  readonly collision: {
    readonly counterpartyRefs: readonly ProviderResourceRef[];
    readonly kind: 'CANONICAL_PARTY_COUNTERPARTY_COLLISION';
  };
  readonly currentRoles: readonly ('CUSTOMER' | 'SUPPLIER')[];
  readonly legalEntity: { readonly legalEntityId: string; readonly tenantId: string };
  readonly party: {
    readonly archived: boolean;
    readonly matchedViaAlias: boolean;
    readonly ref: ProviderResourceRef;
    readonly title?: string;
  };
  readonly ref: ProviderResourceRef;
}

/** Runs one search whose provider returns exactly the value handed in (E-BATCH needs no batching here). */
const counterpartyProviderSearch = (value: CounterpartyProviderResult) =>
  makeShellSearch(dependencies({ access: 'allowed' }), { search: () => Effect.succeed([value]) }).search(
    context,
    'canonical',
  );

it.effect('search treats empty input as empty without touching providers or the gate', () =>
  Effect.gen(function* searchTreatsEmptyInputAsEmpty() {
    let calls = 0;
    const baseline = dependencies({ access: 'allowed' });
    const search = makeShellSearch(baseline, {
      search: () => {
        calls += 1;
        return Effect.succeed([]);
      },
    });
    expect(yield* search.search(context, '   ')).toEqual({
      partial: false,
      results: [],
    });
    expect(calls).toBe(0);
    expect(baseline.access.decisions).toEqual([]);
  }),
);

it.effect('search asks every eligible provider in one batched decision', () =>
  Effect.gen(function* searchAsksEveryProviderInOneBatch() {
    const baseline = dependencies({ access: 'allowed' });
    const result = yield* makeShellSearch(baseline, { search: () => Effect.succeed([]) }).search(context, 'unit');
    expect(result).toEqual({ partial: false, presentation: emptyPresentation, results: [] });
    // E-BATCH: one provider, one engine snapshot, no single-question call.
    expect({ batches: baseline.access.batches.length, singles: baseline.access.singleDecisions.length }).toEqual({
      batches: 1,
      singles: 0,
    });
    expect(baseline.access.batches[0]?.map(({ carrier }) => carrier.accessDeclaration?.key)).toEqual([SEARCH_KEY]);
  }),
);

it.effect('omits a provider its declaration denies and reports partial provider failure', () =>
  Effect.gen(function* omitsDeniedProviderAndReportsPartialFailure() {
    let calls = 0;
    expect(
      yield* makeShellSearch(dependencies({ access: 'denied' }), {
        search: () => {
          calls += 1;
          return Effect.succeed([resourceHit]);
        },
      }).search(context, ' unit '),
    ).toEqual({ partial: false, presentation: emptyPresentation, results: [] });
    expect(calls).toBe(0);

    const installed = yield* catalog();
    const [contract] = installed.contracts;
    if (contract === undefined) {
      throw new TypeError('The search fixture must install its module contract');
    }
    const backupSearchKey = 'property.registry.backup-unit-search';
    const backupDeclarationKey = 'property.registry.backup.search';
    const catalogWithBackupSearch = yield* makeInstalledModuleCatalogLoader(
      makeCompositionSnapshot([
        {
          ...contract,
          manifest: {
            ...contract.manifest,
            publicSurface: {
              ...contract.manifest.publicSurface,
              search: [
                ...contract.manifest.publicSurface.search,
                {
                  accessFiltering: 'resource_permission' as const,
                  key: backupSearchKey,
                  legalEntityScope: 'required' as const,
                  owningModuleId: moduleId,
                  resourceType,
                },
              ],
              shellContributions: {
                ...contract.manifest.publicSurface.shellContributions,
                search: [
                  ...contract.manifest.publicSurface.shellContributions.search,
                  {
                    accessDeclaration: declaration(backupDeclarationKey),
                    contributionKey: 'property.registry.search.backup-unit',
                    entrypoint: {
                      ...entrypoint('search'),
                      entrypointKey: 'property.registry.search.backup',
                    },
                    searchKey: backupSearchKey,
                  },
                ],
              },
            },
          },
        },
      ]),
    );
    const baseline = dependencies({ access: 'allowed', extraAnswers: { [backupDeclarationKey]: 'allowed' } });
    const partial = makeShellSearch(
      { ...baseline, catalog: Effect.succeed(catalogWithBackupSearch) },
      {
        search: ({ searchKey }) =>
          searchKey === backupSearchKey
            ? Effect.fail(new ShellProviderUnavailableError())
            : Effect.succeed([resourceHit]),
      },
    );
    expect(yield* partial.search(context, 'unit')).toEqual({
      partial: true,
      presentation: emptyPresentation,
      results: [{ ...resourceHit, kind: 'resource' }],
    });
    expect(baseline.access.batches[0]).toHaveLength(2);
  }),
);

const partyModuleId = 'party.registry';
const partyResourceType = 'party.registry.party';
const PARTY_SEARCH_KEY = 'party.registry.party.search';

const partyContract = {
  ...propertyContract,
  deployment: { ...propertyContract.deployment, appId: 'party-registry' },
  manifest: {
    ...propertyContract.manifest,
    module: { ...propertyContract.manifest.module, id: partyModuleId },
    publicSurface: {
      ...propertyContract.manifest.publicSurface,
      actions: [],
      api: [],
      resourceTypes: [
        {
          capabilities: {
            graphVisible: false,
            linkable: true,
            mediaAttachable: false,
            searchable: true,
            timelineVisible: false,
          },
          description: 'A party.',
          key: partyResourceType,
          label: 'Party',
          owningModuleId: partyModuleId,
        },
      ],
      search: [
        {
          accessFiltering: 'tenant_scope' as const,
          key: PARTY_SEARCH_KEY,
          legalEntityScope: 'optional' as const,
          owningModuleId: partyModuleId,
          requestFilters: ['includeArchived'] as const,
          resourceType: partyResourceType,
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
            accessDeclaration: declaration(PARTY_SEARCH_KEY),
            contributionKey: 'party.registry.search.party',
            entrypoint: {
              access: 'read' as const,
              authorization: { kind: 'protected' as const },
              entrypointKey: 'party.registry.search.party',
              moduleKey: partyModuleId,
              role: 'search' as const,
              scope: 'tenant' as const,
            },
            searchKey: PARTY_SEARCH_KEY,
          },
        ],
        timelines: [],
      },
    },
  },
};

/**
 * The REAL decision engine over a fixed authority, for the R5b-4 proof: `held` seeds one cell for the
 * Party search capability, and the engine's own list/decide paths answer the question.
 */
const realAccess = (held: boolean): ShellAccessGate => {
  const authority = {
    cells: held ? [cell({ capability: PARTY_SEARCH_KEY, holder: principalHolder(person) })] : [],
  };
  return makeAccessDecisionService({
    authorityFor: () => makeAuthority(authority).port,
    check: makeCheck({ authority }).port,
    decisionLog: { record: () => Effect.void },
    legalEntities: { listCandidateIds: () => Effect.succeed([]) },
    principalKinds: { readKind: () => Effect.succeed(Option.some('human' as const)) },
  });
};

it.effect(
  'a tenant-scoped Party search needs no Legal Entity, is decided in the tenant context and forwards only declared filters',
  () =>
    Effect.gen(function* tenantScopedPartySearchNeedsNo() {
      const partyCatalog = yield* makeInstalledModuleCatalogLoader(makeCompositionSnapshot([partyContract]));
      const calls: unknown[] = [];
      const baseline = dependencies({ access: 'allowed' });
      const access = makeShellTestAccessGate({ answers: { [PARTY_SEARCH_KEY]: 'allowed' } });
      const result = yield* makeShellSearch(
        { ...baseline, access, catalog: Effect.succeed(partyCatalog) },
        {
          search: (input) => {
            calls.push(input);
            return Effect.succeed([
              {
                archived: true,
                matchedViaAlias: true,
                ref: {
                  moduleId: partyModuleId,
                  resourceId: 'party-1',
                  resourceType: partyResourceType,
                  tenantId,
                },
                title: 'Canonical Party',
              },
            ]);
          },
        },
      ).search(tenantContext, {
        includeArchived: true,
        query: ' party ',
        role: 'CUSTOMER',
      });

      expect(access.batches[0]?.[0]?.legalEntityScope).toBe('optional');
      expect(calls[0]).toMatchObject({ includeArchived: true, query: 'party' });
      expect(calls[0]).not.toHaveProperty('role');
      expect(result).toEqual({
        partial: false,
        presentation: emptyPresentation,
        results: [
          {
            archived: true,
            kind: 'party',
            matchedViaAlias: true,
            ref: {
              moduleId: partyModuleId,
              resourceId: 'party-1',
              resourceType: partyResourceType,
              tenantId,
            },
            title: 'Canonical Party',
          },
        ],
      });
    }),
);

it.effect(
  'refuses a company-scoped search provider without a selected company while the tenant-scoped one still answers',
  () =>
    Effect.gen(function* companyScopedSearchWithoutCompanyIsRefused() {
      // O78 negative control: the scope comes from the descriptor's own `legalEntityScope`, so the
      // company-scoped property provider is refused (no company selected) and its handler never runs,
      // while the tenant-scoped party provider is decided in the tenant context and does run.
      const both = yield* makeInstalledModuleCatalogLoader(makeCompositionSnapshot([propertyContract, partyContract]));
      const calls: string[] = [];
      const access = makeShellTestAccessGate({ answers: { [PARTY_SEARCH_KEY]: 'allowed', [SEARCH_KEY]: 'allowed' } });
      const result = yield* makeShellSearch(
        { ...dependencies({ access: 'allowed' }), access, catalog: Effect.succeed(both) },
        {
          search: ({ searchKey }) => {
            calls.push(searchKey);
            return Effect.succeed([
              {
                archived: false,
                matchedViaAlias: false,
                ref: { moduleId: partyModuleId, resourceId: 'party-1', resourceType: partyResourceType, tenantId },
                title: 'Tenant Party',
              },
            ]);
          },
        },
      ).search(tenantContext, 'party');

      // The company-scoped provider is refused and never called; only the tenant-scoped one runs.
      expect(calls).toEqual([PARTY_SEARCH_KEY]);
      expect([...new Set(access.batches[0]?.map(({ legalEntityScope }) => legalEntityScope))].toSorted()).toEqual([
        'optional',
        'required',
      ]);
      expect(result).toEqual({
        partial: false,
        presentation: emptyPresentation,
        results: [
          {
            archived: false,
            kind: 'party',
            matchedViaAlias: false,
            ref: { moduleId: partyModuleId, resourceId: 'party-1', resourceType: partyResourceType, tenantId },
            title: 'Tenant Party',
          },
        ],
      });
    }),
);

it.effect('admits a record-scoped search provider through the list gate, not a targetless decide (R5b-4)', () =>
  Effect.gen(function* recordScopedSearchProviderUsesTheListGate() {
    // The REAL decision engine: a Party search declaration that names the `all` selector is admitted
    // through the list gate, so its holder sees results and a non-holder does not. A targetless
    // `decide` would refuse both with `deny.target_required` (R5b-4).
    const searchWithAll = {
      ...partyContract,
      manifest: {
        ...partyContract.manifest,
        publicSurface: {
          ...partyContract.manifest.publicSurface,
          shellContributions: {
            ...partyContract.manifest.publicSurface.shellContributions,
            search: partyContract.manifest.publicSurface.shellContributions.search.map((contribution) => ({
              ...contribution,
              accessDeclaration: { ...contribution.accessDeclaration, selectors: ['all' as const] },
            })),
          },
        },
      },
    };
    const scopedCatalog = yield* makeInstalledModuleCatalogLoader(makeCompositionSnapshot([searchWithAll]));
    const scopedContext = shellTestScope({ principalId: person, tenantId: tenant });
    const held = {
      archived: false,
      matchedViaAlias: false,
      ref: { moduleId: partyModuleId, resourceId: 'party-1', resourceType: partyResourceType, tenantId: tenant },
      title: 'Held Party',
    };
    const search = (withGrant: boolean) =>
      makeShellSearch(
        {
          ...dependencies({ access: 'allowed' }),
          access: realAccess(withGrant),
          catalog: Effect.succeed(scopedCatalog),
        },
        { search: () => Effect.succeed([held]) },
      ).search(scopedContext, 'party');

    // The holder of the `all` selector sees the record through the list gate.
    expect(yield* search(true)).toEqual({
      partial: false,
      presentation: emptyPresentation,
      results: [{ ...held, kind: 'party' }],
    });
    // The non-holder is refused: no results, and the provider never runs.
    expect(yield* search(false)).toEqual({ partial: false, presentation: emptyPresentation, results: [] });
  }),
);

it.effect('search fails only when every eligible provider fails', () =>
  Effect.gen(function* searchFailsOnlyWhenEveryEligible() {
    const effect = makeShellSearch(dependencies({ access: 'allowed' }), {
      search: () => Effect.fail(new ShellProviderUnavailableError()),
    }).search(context, 'unit');
    expect(Schema.is(ShellProviderUnavailableError)(yield* Effect.flip(effect))).toBe(true);
  }),
);

it.effect('Counterparty search preserves both identities, selected scope, roles and collision metadata', () =>
  Effect.gen(function* CounterpartySearchPreservesBothIdentitiesSelected() {
    const [contract] = (yield* catalog()).contracts;
    if (contract === undefined) {
      throw new Error('The test catalog must include one installed contract');
    }
    const filteredCatalog = yield* makeInstalledModuleCatalogLoader(
      makeCompositionSnapshot([
        {
          ...contract,
          manifest: {
            ...contract.manifest,
            publicSurface: {
              ...contract.manifest.publicSurface,
              search: contract.manifest.publicSurface.search.map((descriptor) => ({
                ...descriptor,
                requestFilters: ['includeArchived', 'role'] as const,
              })),
            },
          },
        },
      ]),
    );
    const counterpartyRef = { ...ref, tenantId };
    const canonicalPartyRef = {
      ...ref,
      resourceId: 'party-1',
      resourceType: 'property.registry.party',
      tenantId,
    };
    const collision = {
      counterpartyRefs: [counterpartyRef, { ...counterpartyRef, resourceId: 'unit-2' }],
      kind: 'CANONICAL_PARTY_COUNTERPARTY_COLLISION',
    };
    const value = {
      collision,
      currentRoles: ['CUSTOMER', 'SUPPLIER'],
      legalEntity: { legalEntityId, tenantId },
      party: {
        archived: true,
        matchedViaAlias: true,
        ref: canonicalPartyRef,
        title: 'Canonical Party',
      },
      ref: counterpartyRef,
    };
    const calls: unknown[] = [];
    const baseline = dependencies({ access: 'allowed' });
    const search = makeShellSearch(
      { ...baseline, catalog: Effect.succeed(filteredCatalog) },
      {
        search: (input) => {
          calls.push(input);
          return Effect.succeed([value]);
        },
      },
    );
    const result = yield* search.search(context, {
      includeArchived: true,
      query: 'canonical',
      role: 'CUSTOMER',
    });
    expect(calls[0]).toMatchObject({
      includeArchived: true,
      role: 'CUSTOMER',
    });
    // O25: the provider filters its own rows, so the Shell keeps the collision metadata it received.
    expect(result).toEqual({
      partial: false,
      presentation: emptyPresentation,
      results: [{ ...value, kind: 'counterparty', title: 'Canonical Party' }],
    });
    expect(yield* search.search(tenantContext, 'canonical')).toEqual({
      partial: false,
      presentation: emptyPresentation,
      results: [],
    });
    expect(calls).toHaveLength(1);
  }),
);

it.effect('never returns a provider-supplied nested identity outside its own surface or tenant', () =>
  Effect.gen(function* providerSuppliedForeignNestedIdentityIsDropped() {
    const counterpartyRef: ProviderResourceRef = { ...ref, tenantId };
    const canonicalPartyRef: ProviderResourceRef = {
      ...ref,
      resourceId: 'party-1',
      resourceType: 'property.registry.party',
      tenantId,
    };
    const authorized: CounterpartyProviderResult = {
      collision: {
        counterpartyRefs: [counterpartyRef],
        kind: 'CANONICAL_PARTY_COUNTERPARTY_COLLISION',
      },
      currentRoles: ['CUSTOMER'],
      legalEntity: { legalEntityId, tenantId },
      party: { archived: true, matchedViaAlias: true, ref: canonicalPartyRef, title: 'Canonical Party' },
      ref: counterpartyRef,
    };

    // Positive control: the result with only its own nested identity is returned whole, so the
    // negative cases below prove a real drop and not a broken fixture.
    expect((yield* counterpartyProviderSearch(authorized)).results).toHaveLength(1);

    const foreignTenantId = '10000000-0000-4000-8000-0000000000ff';
    for (const { marker, nested } of [
      // Another module's identity: the Shell never forwards a foreign owner's nested record.
      { marker: 'other.registry', nested: { ...counterpartyRef, moduleId: 'other.registry' } },
      // Another resource type of the same module: still not this provider's surface.
      { marker: 'property.registry.other', nested: { ...counterpartyRef, resourceType: 'property.registry.other' } },
      // Another tenant: a cross-tenant nested identity is never the caller's to read.
      { marker: foreignTenantId, nested: { ...counterpartyRef, tenantId: foreignTenantId } },
    ]) {
      const result = yield* counterpartyProviderSearch({
        ...authorized,
        collision: { counterpartyRefs: [nested], kind: 'CANONICAL_PARTY_COUNTERPARTY_COLLISION' },
      });
      // O25: the provider filters its own rows, so the Shell never re-checks per-record read; but a
      // nested identity outside this provider's own module, resource type or tenant is never
      // returned. The unauthorized identity must not appear anywhere in the response.
      expect(result).toEqual({ partial: false, presentation: emptyPresentation, results: [] });
      expect(JSON.stringify(result)).not.toContain(marker);
    }
  }),
);

it.effect('keeps a search row whose governed Party name the caller may not read, after the named rows (O17)', () =>
  Effect.gen(function* searchRowWithoutVisibleName() {
    const named: CounterpartyProviderResult = {
      collision: { counterpartyRefs: [{ ...ref, tenantId }], kind: 'CANONICAL_PARTY_COUNTERPARTY_COLLISION' },
      currentRoles: ['CUSTOMER'],
      legalEntity: { legalEntityId, tenantId },
      party: {
        archived: false,
        matchedViaAlias: false,
        ref: { ...ref, resourceId: 'party-1', resourceType: 'property.registry.party', tenantId },
        title: 'Named Party',
      },
      ref: { ...ref, tenantId },
    };
    const { title: _hidden, ...unnamedParty } = named.party;
    const unnamed: CounterpartyProviderResult = {
      ...named,
      collision: { counterpartyRefs: [{ ...ref, resourceId: 'unit-0', tenantId }], kind: named.collision.kind },
      party: unnamedParty,
      ref: { ...ref, resourceId: 'unit-0', tenantId },
    };
    const result = yield* makeShellSearch(dependencies({ access: 'allowed' }), {
      search: () => Effect.succeed([unnamed, named]),
    }).search(context, 'canonical');
    // The provider redacted the name, so the row carries no title instead of failing the whole provider.
    expect(result).toEqual({
      partial: false,
      presentation: emptyPresentation,
      results: [
        { ...named, kind: 'counterparty', title: 'Named Party' },
        { ...unnamed, kind: 'counterparty' },
      ],
    });
  }),
);

it.effect('treats a missing tenant module-state record as hidden rather than authorization uncertainty', () =>
  Effect.gen(function* treatsAMissingTenantModuleState() {
    let calls = 0;
    const baseline = dependencies({ access: 'allowed' });
    const hiddenDependencies = {
      ...baseline,
      moduleStates: { getTenantModuleStates: () => Effect.succeed([]) },
    };
    expect(
      yield* makeShellSearch(hiddenDependencies, {
        search: () => {
          calls += 1;
          return Effect.succeed([resourceHit]);
        },
      }).search(context, 'unit'),
    ).toEqual({ partial: false, presentation: emptyPresentation, results: [] });
    const gateway = {
      detail: () => {
        calls += 1;
        return Effect.succeed({ fields: [], title: 'Unit 1' });
      },
      timeline: () => Effect.succeed({ entries: [], projectionLagging: false }),
    };
    expect(yield* makeShellResourceDetail(hiddenDependencies, gateway).resolve(context, ref)).toEqual({
      outcome: 'not_found',
    });
    expect(yield* attachShellMedia(context, ref)).toEqual({
      outcome: 'unavailable',
    });
    expect(calls).toBe(0);
    expect(hiddenDependencies.access.decisions).toEqual([]);
  }),
);

it.effect('search fails closed when a provider decision is unavailable', () =>
  Effect.gen(function* searchFailsClosedForUncertainty() {
    expect(
      Schema.is(ShellProviderUnavailableError)(
        yield* Effect.flip(
          makeShellSearch(dependencies({ access: 'unavailable' }), {
            search: () => Effect.succeed([resourceHit]),
          }).search(context, 'unit'),
        ),
      ),
    ).toBe(true);
  }),
);

it.effect('expired composition authority blocks search and resource providers despite granted permissions', () =>
  Effect.gen(function* expiredAuthorityBlocksProviders() {
    const snapshot = yield* makeCompositionSnapshot([propertyContract], 1);
    const baseline = dependencies({ access: 'allowed' });
    const expiredDependencies = {
      ...baseline,
      catalog: makeInstalledModuleCatalogLoader(Effect.succeed(snapshot)),
    };
    let providerCalls = 0;
    yield* TestClock.adjust(Duration.millis(2));
    const search = makeShellSearch(expiredDependencies, {
      search: () => {
        providerCalls += 1;
        return Effect.succeed([resourceHit]);
      },
    });
    expect(Schema.is(ShellProviderUnavailableError)(yield* Effect.flip(search.search(context, 'unit')))).toBe(true);
    const detail = makeShellResourceDetail(expiredDependencies, {
      detail: () => {
        providerCalls += 1;
        return Effect.succeed({ fields: [], title: 'Unit 1' });
      },
      timeline: () => {
        providerCalls += 1;
        return Effect.succeed({ entries: [], projectionLagging: false });
      },
    });
    expect(yield* detail.resolve(context, ref)).toEqual({ outcome: 'unavailable' });
    expect(providerCalls).toBe(0);
  }),
);

it.effect('resource detail returns not found for an unknown module before gate, tenant or provider work', () =>
  Effect.gen(function* resourceDetailDeniesAnUnadmittedModule() {
    const baseline = dependencies({ access: 'allowed' });
    let assertionCalls = 0;
    let providerCalls = 0;
    const requested = Schema.decodeUnknownSync(ResourceRefSchema)({ ...ref, moduleId: 'unknown.registry' });
    const result = yield* makeShellResourceDetail(
      {
        ...baseline,
        issueAssertion: () => {
          assertionCalls += 1;
          return baseline.issueAssertion();
        },
        moduleStates: {
          getTenantModuleStates: () => Effect.die('An unadmitted module must not read tenant state'),
        },
      },
      {
        detail: () => {
          providerCalls += 1;
          return Effect.succeed({ fields: [], title: 'Unit 1' });
        },
        timeline: () => {
          providerCalls += 1;
          return Effect.succeed({ entries: [], projectionLagging: false });
        },
      },
    ).resolve(context, requested);
    expect(result).toEqual({ outcome: 'not_found' });
    expect(assertionCalls).toBe(0);
    expect(providerCalls).toBe(0);
    expect(baseline.access.decisions).toEqual([]);
  }),
);

it.effect('resource detail preserves not found for admitted modules with missing resource types or bindings', () =>
  Effect.gen(function* resourceDetailPreservesNotFoundForAdmittedModules() {
    const baseline = dependencies({ access: 'allowed' });
    let assertionCalls = 0;
    let providerCalls = 0;
    const admittedDependencies = {
      ...baseline,
      issueAssertion: () => {
        assertionCalls += 1;
        return baseline.issueAssertion();
      },
    };
    const provider = {
      detail: () => {
        providerCalls += 1;
        return Effect.succeed({ fields: [], title: 'Unit 1' });
      },
      timeline: () => {
        providerCalls += 1;
        return Effect.succeed({ entries: [], projectionLagging: false });
      },
    };
    const requested = Schema.decodeUnknownSync(ResourceRefSchema)({
      ...ref,
      resourceType: 'property.registry.missing',
    });
    expect(yield* makeShellResourceDetail(admittedDependencies, provider).resolve(context, requested)).toEqual({
      outcome: 'not_found',
    });
    const unboundContract = {
      ...propertyContract,
      manifest: {
        ...propertyContract.manifest,
        publicSurface: {
          ...propertyContract.manifest.publicSurface,
          shellContributions: {
            ...propertyContract.manifest.publicSurface.shellContributions,
            resourceDetails: [],
          },
        },
      },
    };
    expect(
      yield* makeShellResourceDetail(
        {
          ...admittedDependencies,
          catalog: makeInstalledModuleCatalogLoader(makeCompositionSnapshot([unboundContract])),
        },
        provider,
      ).resolve(context, ref),
    ).toEqual({ outcome: 'not_found' });
    expect(assertionCalls).toBe(0);
    expect(providerCalls).toBe(0);
    expect(baseline.access.decisions).toEqual([]);
  }),
);

it.effect('resource detail applies catalog, state and one access decision before providers', () =>
  Effect.gen(function* resourceDetailAppliesCatalogStateAndOneDecision() {
    let calls = 0;
    const provider = {
      detail: () => {
        calls += 1;
        return Effect.succeed({ fields: [], title: 'Unit 1' });
      },
      timeline: () => Effect.succeed({ entries: [], projectionLagging: false }),
    };
    expect(
      yield* makeShellResourceDetail(dependencies({ access: 'allowed', state: 'inactive' }), provider).resolve(
        context,
        ref,
      ),
    ).toEqual({ outcome: 'not_found' });
    const denied = dependencies({ access: 'denied' });
    expect(yield* makeShellResourceDetail(denied, provider).resolve(context, ref)).toEqual({
      outcome: 'forbidden',
    });
    expect(denied.access.singleDecisions).toHaveLength(1);
    expect(denied.access.singleDecisions[0]?.carrier.accessDeclaration?.key).toBe(RESOURCE_DETAIL_KEY);
    const unavailable = dependencies({ access: 'unavailable' });
    expect(yield* makeShellResourceDetail(unavailable, provider).resolve(context, ref)).toEqual({
      outcome: 'unavailable',
    });
    expect(calls).toBe(0);
  }),
);

it.effect('resource detail treats a missing company selection as an unavailable surface', () =>
  Effect.gen(function* resourceDetailTreatsMissingCompanyAsUnavailable() {
    const baseline = dependencies({ access: 'selection_required' });
    expect(
      yield* makeShellResourceDetail(baseline, {
        detail: () => Effect.die('a missing company must not reach the provider'),
        timeline: () => Effect.die('a missing company must not reach the provider'),
      }).resolve(tenantContext, ref),
    ).toEqual({ outcome: 'unavailable' });
    expect(baseline.access.singleDecisions[0]?.legalEntityScope).toBe('required');
  }),
);

it.effect('resource detail sorts an authorized timeline and exposes projection lag', () =>
  Effect.gen(function* resourceDetailSortsAnAuthorizedTimeline() {
    const result = yield* makeShellResourceDetail(
      dependencies({ access: 'allowed', extraAnswers: { [TIMELINE_KEY]: 'allowed' } }),
      {
        detail: () => Effect.succeed({ fields: [], title: 'Unit 1' }),
        timeline: () =>
          Effect.succeed({
            entries: [
              {
                occurredAt: '2026-01-01T00:00:00Z',
                summary: 'Created',
                timelineEntryId: '1',
              },
              {
                occurredAt: '2026-02-01T00:00:00Z',
                summary: 'Updated',
                timelineEntryId: '2',
              },
            ],
            projectionLagging: true,
          }),
      },
    ).resolve(context, ref);
    expect(result).toEqual({
      detail: { fields: [], title: 'Unit 1' },
      media: { enabled: false, reason: 'unavailable' },
      outcome: 'resolved',
      projectionLagging: true,
      timeline: [
        {
          occurredAt: DateTime.makeUnsafe('2026-02-01T00:00:00Z'),
          summary: 'Updated',
          timelineEntryId: '2',
        },
        {
          occurredAt: DateTime.makeUnsafe('2026-01-01T00:00:00Z'),
          summary: 'Created',
          timelineEntryId: '1',
        },
      ],
    });
    if (result.outcome !== 'resolved') {
      throw new TypeError('The authorized resource fixture must resolve');
    }
    expect(yield* Schema.encodeEffect(Schema.Array(ShellTimelineEntrySchema))(result.timeline)).toEqual([
      {
        occurredAt: '2026-02-01T00:00:00.000Z',
        summary: 'Updated',
        timelineEntryId: '2',
      },
      {
        occurredAt: '2026-01-01T00:00:00.000Z',
        summary: 'Created',
        timelineEntryId: '1',
      },
    ]);
  }),
);

it.effect('never fetches a timeline whose own declaration is denied while the detail is allowed (UNCLEAR-1)', () =>
  Effect.gen(function* timelineDenied() {
    let timelineCalls = 0;
    const result = yield* makeShellResourceDetail(dependencies({ access: 'allowed' }), {
      detail: () => Effect.succeed({ fields: [], title: 'Unit 1' }),
      timeline: () => {
        timelineCalls += 1;
        return Effect.succeed({ entries: [], projectionLagging: false });
      },
    }).resolve(context, ref);
    // The detail is allowed; the timeline's own declaration is unnamed and therefore denied, so its
    // provider never runs and the timeline is empty rather than silently fetched (O62, UNCLEAR-1).
    expect(result).toEqual({
      detail: { fields: [], title: 'Unit 1' },
      media: { enabled: false, reason: 'unavailable' },
      outcome: 'resolved',
      projectionLagging: false,
      timeline: [],
    });
    expect(timelineCalls).toBe(0);
  }),
);

it.effect('media affordance remains unavailable until a generated Action exists', () =>
  Effect.gen(function* mediaAffordanceRemainsUnavailableUntilA() {
    const provider = {
      detail: () => Effect.succeed({ fields: [], title: 'Unit 1' }),
      timeline: () => Effect.succeed({ entries: [], projectionLagging: false }),
    };
    expect(
      yield* makeShellResourceDetail(dependencies({ access: 'allowed', state: 'read_only' }), provider).resolve(
        context,
        ref,
      ),
    ).toMatchObject({
      media: { enabled: false, reason: 'read_only' },
    });
    expect(
      yield* makeShellResourceDetail(dependencies({ access: 'allowed' }), provider).resolve(context, ref),
    ).toMatchObject({
      media: { enabled: false, reason: 'unavailable' },
    });
  }),
);

it.effect('media endpoint cannot invoke a provider mutation', () =>
  Effect.gen(function* mediaEndpointCannotInvokeAProvider() {
    expect(yield* attachShellMedia(context, ref)).toEqual({
      outcome: 'unavailable',
    });
  }),
);

it.effect('acquires a fresh audience-scoped assertion for each provider attempt', () =>
  Effect.gen(function* acquiresAFreshAudienceScopedAssertion() {
    const authorizations: string[] = [];
    const assertions: Parameters<ShellProviderAssertionIssuer['issueAssertion']>[0][] = [];
    const approved = yield* catalog();
    const baseline = dependencies({ access: 'allowed', extraAnswers: { [TIMELINE_KEY]: 'allowed' } });
    let catalogLoads = 0;
    const capturedDependencies = {
      ...baseline,
      catalog: Effect.sync(() => {
        catalogLoads += 1;
        return approved;
      }),
      issueAssertion: (input: Parameters<ShellProviderAssertionIssuer['issueAssertion']>[0]) => {
        assertions.push(input);
        return baseline.issueAssertion();
      },
    };
    const result = yield* makeShellResourceDetail(capturedDependencies, {
      detail: ({ authorization }) => {
        authorizations.push(authorization);
        return Effect.succeed({ fields: [], title: 'Unit 1' });
      },
      timeline: ({ authorization }) => {
        authorizations.push(authorization);
        return Effect.succeed({ entries: [], projectionLagging: false });
      },
    }).resolve(context, ref);
    expect(result.outcome).toBe('resolved');
    expect(authorizations).toEqual(['Bearer test-0', 'Bearer test-1']);
    expect(catalogLoads).toBe(1);
    expect(assertions).toEqual([
      { appId: 'property-registry', compositionRevision: approved.composition.revision, context },
      { appId: 'property-registry', compositionRevision: approved.composition.revision, context },
    ]);
  }),
);

it.effect('search issues assertions for the release captured by its single catalog load', () =>
  Effect.gen(function* searchCapturesApprovedRelease() {
    const approved = yield* catalog();
    const assertions: Parameters<ShellProviderAssertionIssuer['issueAssertion']>[0][] = [];
    const baseline = dependencies({ access: 'allowed' });
    let catalogLoads = 0;
    const result = yield* makeShellSearch(
      {
        ...baseline,
        catalog: Effect.sync(() => {
          catalogLoads += 1;
          return approved;
        }),
        issueAssertion: (input) => {
          assertions.push(input);
          return baseline.issueAssertion();
        },
      },
      { search: () => Effect.succeed([resourceHit]) },
    ).search(context, 'unit');
    expect(result).toEqual({
      partial: false,
      presentation: emptyPresentation,
      results: [{ ...resourceHit, kind: 'resource' }],
    });
    expect(catalogLoads).toBe(1);
    expect(assertions).toEqual([
      { appId: 'property-registry', compositionRevision: approved.composition.revision, context },
    ]);
  }),
);

const providerRequest = Effect.gen(function* providerRequestFixture() {
  const approved = yield* catalog();
  const [module] = approved.composition.modules;
  if (module === undefined) {
    return yield* Effect.die('The fixture composition admits the property registry');
  }
  return {
    appId: 'property-registry',
    authorization: 'Bearer owner-assertion',
    correlationId: 'unit-correlation',
    includeArchived: false,
    module,
    query: 'dvořák',
    searchKey: 'property.registry.unit-search',
  } as const;
});

it.effect("the search gateway posts to the provider's own BFF route on the approved release", () =>
  Effect.gen(function* searchGatewayPostsToOwnerRoute() {
    const request = yield* providerRequest;
    const sent: { readonly body: unknown; readonly headers: Headers; readonly method: string; readonly url: string }[] =
      [];
    const gateway = makeModuleSearchProviderGateway((outgoing: Request, module: ApplicationCompositionModule) =>
      Effect.promise(async () => {
        sent.push({
          body: await outgoing.json(),
          headers: outgoing.headers,
          method: outgoing.method,
          url: `${module.deployment.appId} ${new URL(outgoing.url).pathname}`,
        });
        return Response.json([{ ref, selectedLegalEntityId: legalEntityId, title: 'Unit 1' }]);
      }),
    );
    expect(yield* gateway.search(request)).toEqual([{ ref, selectedLegalEntityId: legalEntityId, title: 'Unit 1' }]);
    expect(sent.map(({ body, method, url }) => ({ body, method, url }))).toEqual([
      {
        body: { includeArchived: false, query: 'dvořák' },
        method: 'POST',
        url: 'property-registry /property-registry-api/property.registry/search/unit-search',
      },
    ]);
    expect(sent[0]?.headers.get('authorization')).toBe('Bearer owner-assertion');
    expect(sent[0]?.headers.get('x-correlation-id')).toBe('unit-correlation');
  }),
);

it.effect(
  'the search gateway preserves owner entrypoint403, successful filtered200 and unavailable failures distinctly',
  () =>
    Effect.gen(function* searchGatewayFailsClosed() {
      const request = yield* providerRequest;
      let calls = 0;
      const respondWith = (status: number) =>
        makeModuleSearchProviderGateway(() =>
          Effect.sync(() => {
            calls += 1;
            return Response.json({ _tag: 'UnitSearchProviderProblem' }, { status });
          }),
        );
      const denied = yield* Effect.flip(respondWith(403).search(request));
      expect(Schema.is(ReadPermissionDenied)(denied)).toBe(true);
      expect(JSON.stringify(denied)).not.toContain('UnitSearchProviderProblem');
      expect(yield* makeModuleSearchProviderGateway(() => Effect.succeed(Response.json([]))).search(request)).toEqual(
        [],
      );
      const outage = yield* Effect.flip(respondWith(503).search(request));
      expect(Schema.is(ShellProviderUnavailableError)(outage)).toBe(true);
      const foreign = yield* Effect.flip(respondWith(200).search({ ...request, searchKey: 'party.registry.parties' }));
      expect(Schema.is(ShellProviderUnavailableError)(foreign)).toBe(true);
      expect(calls).toBe(2);
    }),
);

it.effect(
  'an admitted search owner entrypoint403 is one attempt and a sanitized overall permission denial, never retried or empty',
  () =>
    Effect.gen(function* entrypointRefusalIsForbidden() {
      let assertions = 0;
      let ownerCalls = 0;
      const base = dependencies({ access: 'allowed' });
      const gateway = makeModuleSearchProviderGateway(() =>
        Effect.sync(() => {
          ownerCalls += 1;
          return Response.json({ credential: 'PRIVATE-JWT', privateOwnerDiagnostic: 'DO-NOT-EXPOSE' }, { status: 403 });
        }),
      );
      const failure = yield* Effect.flip(
        makeShellSearch(
          {
            ...base,
            issueAssertion: () => {
              assertions += 1;
              return Effect.succeed('Bearer owner-test-assertion');
            },
          },
          gateway,
        ).search(context, 'Unit'),
      );
      expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
      expect(assertions).toBe(1);
      expect(ownerCalls).toBe(1);
      expect(JSON.stringify(failure)).not.toContain('DO-NOT-EXPOSE');
      expect(JSON.stringify(failure)).not.toContain('PRIVATE-JWT');
    }),
);

it.effect('an owner-filtered200 collection remains successful and is not confused with entrypoint403', () =>
  Effect.gen(function* filteredCollectionIsEmptySuccess() {
    let ownerCalls = 0;
    const gateway = makeModuleSearchProviderGateway(() =>
      Effect.sync(() => {
        ownerCalls += 1;
        return Response.json([]);
      }),
    );
    expect(yield* makeShellSearch(dependencies({ access: 'allowed' }), gateway).search(context, 'Unit')).toEqual({
      partial: false,
      presentation: emptyPresentation,
      results: [],
    });
    expect(ownerCalls).toBe(1);
  }),
);

it.effect('fresh-assertion retries consume the original provider deadline instead of extending it', () =>
  Effect.gen(function* boundedRetry() {
    const baseline = dependencies({ access: 'allowed' });
    const installed = yield* baseline.catalog;
    const assertions: string[] = [];
    let completed = false;
    const pending = yield* makeShellSearch(
      { ...baseline, catalog: Effect.succeed(installed) },
      {
        search: ({ authorization }) => {
          assertions.push(authorization);
          const first = assertions.length === 1;
          // The first attempt fails inside the provider deadline and gets its retry; the deadline then cuts the retry.
          return Effect.sleep(SHELL_SEARCH_PROVIDER_DEADLINE_MILLIS * 0.6).pipe(
            Effect.flatMap(() =>
              first
                ? Effect.fail(new ShellProviderUnavailableError({}))
                : Effect.sync(() => {
                    completed = true;
                    return [{ ref, title: 'Unit 1' }];
                  }),
            ),
          );
        },
      },
    )
      .search(context, 'unit')
      .pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust(SHELL_SEARCH_REQUEST_BUDGET_MILLIS);
    expect(Schema.is(ShellProviderUnavailableError)(yield* Fiber.join(pending))).toBe(true);
    expect(assertions).toHaveLength(2);
    expect(new Set(assertions).size).toBe(2);
    yield* TestClock.adjust(SHELL_SEARCH_REQUEST_BUDGET_MILLIS);
    expect(completed).toBe(false);
  }),
);

it.effect('a provider past its own deadline is left out, the answer is partial and the other hits survive', () =>
  Effect.gen(function* slowProviderHitsItsDeadline() {
    const both = yield* makeInstalledModuleCatalogLoader(makeCompositionSnapshot([propertyContract, partyContract]));
    const access = makeShellTestAccessGate({ answers: { [PARTY_SEARCH_KEY]: 'allowed', [SEARCH_KEY]: 'allowed' } });
    const logs: string[] = [];
    let slowInterrupted = false;
    const logger = Logger.layer([
      Logger.make((options) => {
        logs.push(JSON.stringify(Logger.formatStructured.log(options)));
      }),
    ]);
    const fiber = yield* makeShellSearch(
      { ...dependencies({ access: 'allowed' }), access, catalog: Effect.succeed(both) },
      {
        search: ({ searchKey }) =>
          searchKey === PARTY_SEARCH_KEY
            ? Effect.never.pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    slowInterrupted = true;
                  }),
                ),
              )
            : Effect.succeed([resourceHit]),
      },
    )
      .search(context, 'unit')
      .pipe(Effect.provide(logger), Effect.forkChild);
    // Let the forked search reach its own waits before the clock moves past the deadline.
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(SHELL_SEARCH_PROVIDER_DEADLINE_MILLIS));
    // Checked without waiting, so a search still stuck on the slow owner fails here instead of hanging.
    expect(fiber.pollUnsafe()).not.toBeUndefined();
    expect(yield* Fiber.join(fiber)).toEqual({
      partial: true,
      presentation: emptyPresentation,
      results: [{ ...resourceHit, kind: 'resource' }],
    });
    // The slow owner's call is interrupted, not left running unawaited.
    expect(slowInterrupted).toBe(true);
    // The provider that never answered writes one line saying it passed its deadline: its id, never the query.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(PARTY_SEARCH_KEY);
    expect(logs[0]).toContain('deadline');
  }),
);

it.effect('providers that answer at once are unchanged by the per-provider deadline', () =>
  Effect.gen(function* fastProvidersAreNotCut() {
    const both = yield* makeInstalledModuleCatalogLoader(makeCompositionSnapshot([propertyContract, partyContract]));
    const access = makeShellTestAccessGate({ answers: { [PARTY_SEARCH_KEY]: 'allowed', [SEARCH_KEY]: 'allowed' } });
    expect(
      yield* makeShellSearch(
        { ...dependencies({ access: 'allowed' }), access, catalog: Effect.succeed(both) },
        {
          search: ({ searchKey }) =>
            searchKey === PARTY_SEARCH_KEY ? Effect.succeed([]) : Effect.succeed([resourceHit]),
        },
      ).search(context, 'unit'),
    ).toEqual({
      partial: false,
      presentation: emptyPresentation,
      results: [{ ...resourceHit, kind: 'resource' }],
    });
  }),
);

it.effect('an owner that fails once and answers on the retry still counts', () =>
  Effect.gen(function* retryAnswerCounts() {
    let calls = 0;
    const result = yield* makeShellSearch(dependencies({ access: 'allowed' }), {
      search: () => {
        calls += 1;
        return calls === 1 ? Effect.fail(new ShellProviderUnavailableError()) : Effect.succeed([resourceHit]);
      },
    }).search(context, 'unit');
    expect(result).toEqual({
      partial: false,
      presentation: emptyPresentation,
      results: [{ ...resourceHit, kind: 'resource' }],
    });
    expect(calls).toBe(2);
  }),
);
