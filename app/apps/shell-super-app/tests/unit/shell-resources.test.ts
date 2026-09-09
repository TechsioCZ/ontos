import { buildInstalledModuleCatalog } from '@app/core-runtime';
import type {
  ContextAccessDecision,
  ContextAccessService,
  InstalledModuleCatalog,
  TenantModuleState,
} from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  attachShellMedia,
  makeShellResourceDetail,
  makeShellSearch,
  ResourceRefSchema,
  ShellProviderUnavailableError,
  ShellTimelineEntrySchema,
} from '../../api/modules/shell-resources.ts';

const moduleId = 'property.registry';
const resourceType = 'property.registry.unit';
const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const context = {
  authMethod: 'system' as const,
  correlationId: 'unit-correlation',
  legalEntityId,
  principalId,
  tenantId,
} as const;
const tenantContext = {
  authMethod: context.authMethod,
  correlationId: context.correlationId,
  principalId: context.principalId,
  tenantId: context.tenantId,
} as const;
const ref = Schema.decodeUnknownSync(ResourceRefSchema)({
  moduleId,
  resourceId: 'unit-1',
  resourceType,
});
const entrypoint = (role: 'api' | 'search', access: 'read' | 'write' = 'read') => ({
  access,
  authorization: {
    kind: 'context_permission' as const,
    permission: access === 'write' ? 'resource_write' : 'resource_read',
  },
  entrypointKey: `${moduleId}.${role}.${access}`,
  moduleKey: moduleId,
  role,
  scope: 'tenant' as const,
});

const catalog = (): InstalledModuleCatalog =>
  buildInstalledModuleCatalog([
    {
      contract: {
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
                actionKey: 'property.registry.attach-media',
                auditProfile: 'standard',
                entrypoint: {
                  access: 'write',
                  authorization: {
                    kind: 'action_execution',
                    provisioning: 'tenant_membership_default',
                  },
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
                owningModuleId: moduleId,
                resourceType,
              },
            ],
            shellContributions: {
              mediaAttachments: [
                {
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
                  apiKey: 'property.registry.resource-api',
                  contributionKey: 'property.registry.resource.unit',
                  entrypoint: entrypoint('api'),
                  resourceType,
                },
              ],
              search: [
                {
                  contributionKey: 'property.registry.search.unit',
                  entrypoint: entrypoint('search'),
                  searchKey: 'property.registry.unit-search',
                },
              ],
              timelines: [
                {
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
      },
      expectedAppId: 'property-registry',
    },
  ]);

const access = (
  moduleDecision: ContextAccessDecision = 'allowed',
  resourceDecision: ContextAccessDecision = 'allowed',
  resourceWriteDecision: ContextAccessDecision = resourceDecision,
): ContextAccessService => ({
  legalEntities: () => Effect.succeed([]),
  modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: moduleDecision, key }))),
  resources: ({ permission = 'read', resources }) =>
    Effect.succeed(
      resources.map(({ moduleId: owner, resourceId, resourceType: type }) => ({
        decision: permission === 'write' ? resourceWriteDecision : resourceDecision,
        key: `${owner}:${type}:${resourceId}`,
      })),
    ),
  tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: moduleDecision, key }))),
});

const dependencies = (
  state: TenantModuleState = 'active',
  moduleDecision: ContextAccessDecision = 'allowed',
  resourceDecision: ContextAccessDecision = 'allowed',
  resourceWriteDecision: ContextAccessDecision = resourceDecision,
) => {
  let assertion = 0;
  return {
    catalog: Effect.succeed(catalog()),
    contextAccess: access(moduleDecision, resourceDecision, resourceWriteDecision),
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

it.effect('search treats empty input as empty without touching providers', () =>
  Effect.gen(function* searchTreatsEmptyInputAsEmpty() {
    let calls = 0;
    const search = makeShellSearch(dependencies(), {
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
  }),
);

it.effect('search keeps an eligible provider with zero candidates as a successful empty result', () =>
  Effect.gen(function* searchKeepsAnEligibleProviderWith() {
    const baseline = dependencies();
    const result = yield* makeShellSearch(
      {
        ...baseline,
        contextAccess: {
          ...baseline.contextAccess,
          resources: () => Effect.die('empty results must not authorize an empty resource batch'),
        },
      },
      { search: () => Effect.succeed([]) },
    ).search(context, 'unit');
    expect(result).toEqual({ partial: false, results: [] });
  }),
);

it.effect('search filters resource denials and reports partial provider failure', () =>
  Effect.gen(function* searchFiltersResourceDenialsAndReports() {
    const result = yield* makeShellSearch(dependencies('active', 'allowed', 'denied'), {
      search: () => Effect.succeed([{ ref, title: 'Unit 1' }]),
    }).search(context, ' unit ');
    expect(result).toEqual({ partial: false, results: [] });

    const installed = catalog();
    const [contract] = installed.contracts;
    if (contract === undefined) {
      throw new TypeError('The search fixture must install its module contract');
    }
    const backupSearchKey = 'property.registry.backup-unit-search';
    const catalogWithBackupSearch = buildInstalledModuleCatalog([
      {
        contract: {
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
                  owningModuleId: moduleId,
                  resourceType,
                },
              ],
              shellContributions: {
                ...contract.manifest.publicSurface.shellContributions,
                search: [
                  ...contract.manifest.publicSurface.shellContributions.search,
                  {
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
        expectedAppId: 'property-registry',
      },
    ]);
    const partial = makeShellSearch(
      {
        ...dependencies(),
        catalog: Effect.succeed(catalogWithBackupSearch),
      },
      {
        search: ({ searchKey }) =>
          searchKey === backupSearchKey
            ? Effect.fail(new ShellProviderUnavailableError())
            : Effect.succeed([{ ref, title: 'Unit 1' }]),
      },
    );
    expect(yield* partial.search(context, 'unit')).toEqual({
      partial: true,
      results: [{ kind: 'resource', ref, title: 'Unit 1' }],
    });
  }),
);

it.effect(
  'tenant-scoped Party search needs no Legal Entity, forwards declared filters and preserves identity metadata',
  () =>
    Effect.gen(function* tenantScopedPartySearchNeedsNo() {
      const installed = catalog();
      const [contract] = installed.contracts;
      if (contract === undefined) {
        throw new Error('The test catalog must include one installed contract');
      }
      const [partyResourceDescriptor] = contract.manifest.publicSurface.resourceTypes;
      if (partyResourceDescriptor === undefined) {
        throw new Error('The test catalog must include one resource type');
      }
      const partyResourceType = 'party.registry.party';
      const partySearchKey = 'party.registry.party-search';
      const partyModuleId = 'party.registry';
      const partyContract = {
        ...contract,
        deployment: { ...contract.deployment, appId: 'party-registry' },
        manifest: {
          ...contract.manifest,
          module: { ...contract.manifest.module, id: partyModuleId },
          publicSurface: {
            ...contract.manifest.publicSurface,
            actions: [],
            api: [],
            resourceTypes: [
              {
                ...partyResourceDescriptor,
                key: partyResourceType,
                owningModuleId: partyModuleId,
              },
            ],
            search: [
              {
                accessFiltering: 'tenant_scope' as const,
                key: partySearchKey,
                owningModuleId: partyModuleId,
                requestFilters: ['includeArchived'] as const,
                resourceType: partyResourceType,
                tenantPermission: 'read_party_identity' as const,
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
                  contributionKey: 'party.registry.search.party',
                  entrypoint: {
                    access: 'read' as const,
                    authorization: {
                      kind: 'context_permission' as const,
                      permission: 'module.access',
                    },
                    entrypointKey: 'party.registry.search.party',
                    moduleKey: partyModuleId,
                    role: 'search' as const,
                    scope: 'tenant' as const,
                  },
                  searchKey: partySearchKey,
                },
              ],
              timelines: [],
            },
          },
        },
      };
      const partyCatalog = buildInstalledModuleCatalog([{ contract: partyContract, expectedAppId: 'party-registry' }]);
      const calls: unknown[] = [];
      const baseline = dependencies();
      const result = yield* makeShellSearch(
        {
          ...baseline,
          catalog: Effect.succeed(partyCatalog),
          contextAccess: {
            ...baseline.contextAccess,
            modules: () => Effect.die('tenant-scoped search must not require module access'),
            resources: () => Effect.die('tenant-scoped search must not require resource access'),
            tenants: ({ permission, tenantIds }) => {
              calls.push({ permission, tenantIds });
              return Effect.succeed([{ decision: 'allowed', key: tenantId }]);
            },
          },
        },
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

      expect(calls[0]).toEqual({
        permission: 'read_party_identity',
        tenantIds: [tenantId],
      });
      expect(calls[1]).toMatchObject({ includeArchived: true, query: 'party' });
      expect(calls[1]).not.toHaveProperty('role');
      expect(result).toEqual({
        partial: false,
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

it.effect('search fails only when every eligible provider fails', () =>
  Effect.gen(function* searchFailsOnlyWhenEveryEligible() {
    const effect = makeShellSearch(dependencies(), {
      search: () => Effect.fail(new ShellProviderUnavailableError()),
    }).search(context, 'unit');
    expect(Schema.is(ShellProviderUnavailableError)(yield* Effect.flip(effect))).toBe(true);
  }),
);

it.effect('Counterparty search preserves both identities, selected scope, roles and collision metadata', () =>
  Effect.gen(function* CounterpartySearchPreservesBothIdentitiesSelected() {
    const [contract] = catalog().contracts;
    if (contract === undefined) {
      throw new Error('The test catalog must include one installed contract');
    }
    const filteredCatalog = buildInstalledModuleCatalog([
      {
        contract: {
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
        expectedAppId: 'property-registry',
      },
    ]);
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
    const search = makeShellSearch(
      { ...dependencies(), catalog: Effect.succeed(filteredCatalog) },
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
    expect(result).toEqual({
      partial: false,
      results: [{ ...value, kind: 'counterparty', title: 'Canonical Party' }],
    });
    expect(yield* search.search(tenantContext, 'canonical')).toEqual({
      partial: false,
      results: [],
    });
    expect(calls).toHaveLength(1);
    const baseline = dependencies();
    const redacted = yield* makeShellSearch(
      {
        ...baseline,
        catalog: Effect.succeed(filteredCatalog),
        contextAccess: {
          ...baseline.contextAccess,
          resources: ({ resources }) =>
            Effect.succeed(
              resources.map((resource) => ({
                decision: resource.resourceId === 'unit-2' ? ('denied' as const) : ('allowed' as const),
                key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
              })),
            ),
        },
      },
      { search: () => Effect.succeed([value]) },
    ).search(context, 'canonical');
    expect(JSON.stringify(redacted)).not.toContain('unit-2');
    expect(redacted.results[0]).not.toHaveProperty('collision');
  }),
);

it.effect('treats a missing tenant module-state record as hidden rather than authorization uncertainty', () =>
  Effect.gen(function* treatsAMissingTenantModuleState() {
    let calls = 0;
    const hiddenDependencies = {
      ...dependencies(),
      moduleStates: { getTenantModuleStates: () => Effect.succeed([]) },
    };
    expect(
      yield* makeShellSearch(hiddenDependencies, {
        search: () => {
          calls += 1;
          return Effect.succeed([{ ref, title: 'Unit 1' }]);
        },
      }).search(context, 'unit'),
    ).toEqual({ partial: false, results: [] });
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
  }),
);

it.effect('search fails closed for module or resource authorization uncertainty', () =>
  Effect.gen(function* searchFailsClosedForModuleOr() {
    expect(
      Schema.is(ShellProviderUnavailableError)(
        yield* Effect.flip(
          makeShellSearch(dependencies('active', 'unavailable'), {
            search: () => Effect.succeed([{ ref, title: 'Unit 1' }]),
          }).search(context, 'unit'),
        ),
      ),
    ).toBe(true);
    expect(
      Schema.is(ShellProviderUnavailableError)(
        yield* Effect.flip(
          makeShellSearch(dependencies('active', 'allowed', 'unavailable'), {
            search: () => Effect.succeed([{ ref, title: 'Unit 1' }]),
          }).search(context, 'unit'),
        ),
      ),
    ).toBe(true);
  }),
);

it.effect('resource detail applies catalog, state, module and resource gates before providers', () =>
  Effect.gen(function* resourceDetailAppliesCatalogStateModule() {
    let calls = 0;
    const provider = {
      detail: () => {
        calls += 1;
        return Effect.succeed({ fields: [], title: 'Unit 1' });
      },
      timeline: () => Effect.succeed({ entries: [], projectionLagging: false }),
    };
    expect(yield* makeShellResourceDetail(dependencies('inactive'), provider).resolve(context, ref)).toEqual({
      outcome: 'not_found',
    });
    expect(yield* makeShellResourceDetail(dependencies('active', 'denied'), provider).resolve(context, ref)).toEqual({
      outcome: 'forbidden',
    });
    expect(
      yield* makeShellResourceDetail(dependencies('active', 'allowed', 'unavailable'), provider).resolve(context, ref),
    ).toEqual({ outcome: 'unavailable' });
    expect(calls).toBe(0);
  }),
);

it.effect('resource detail sorts an authorized timeline and exposes projection lag', () =>
  Effect.gen(function* resourceDetailSortsAnAuthorizedTimeline() {
    const result = yield* makeShellResourceDetail(dependencies(), {
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
    }).resolve(context, ref);
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

it.effect('media affordance remains unavailable until a generated Action exists', () =>
  Effect.gen(function* mediaAffordanceRemainsUnavailableUntilA() {
    const provider = {
      detail: () => Effect.succeed({ fields: [], title: 'Unit 1' }),
      timeline: () => Effect.succeed({ entries: [], projectionLagging: false }),
    };
    expect(yield* makeShellResourceDetail(dependencies('read_only'), provider).resolve(context, ref)).toMatchObject({
      media: { enabled: false, reason: 'read_only' },
    });
    expect(
      yield* makeShellResourceDetail(dependencies('active', 'allowed', 'allowed', 'denied'), provider).resolve(
        context,
        ref,
      ),
    ).toMatchObject({ media: { enabled: false, reason: 'unavailable' } });
    expect(yield* makeShellResourceDetail(dependencies(), provider).resolve(context, ref)).toMatchObject({
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
    const result = yield* makeShellResourceDetail(dependencies(), {
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
  }),
);
