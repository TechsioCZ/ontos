import { expect, test } from '@rstest/core';
import { buildInstalledModuleCatalog } from '@app/core-runtime';
import type {
  ContextAccessDecision,
  ContextAccessService,
  InstalledModuleCatalog,
  TenantModuleState,
} from '@app/core-runtime';
import { Deferred, Effect, Exit, Fiber, Redacted } from 'effect';
import {
  attachShellMedia,
  makeShellResourceDetail,
  makeShellSearch,
  ShellProviderUnavailableError,
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
const ref = { moduleId, resourceId: 'unit-1', resourceType } as const;
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
            supportedStates: [
              'inactive',
              'active',
              'read_only',
              'suspended',
              'quarantined',
              'deprecated',
              'archived',
            ],
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
            api: [{ key: 'property.registry.resource-api', operationKeys: ['detail'] }],
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
  modules: ({ moduleIds }) =>
    Effect.succeed(moduleIds.map((key) => ({ decision: moduleDecision, key }))),
  resources: ({ permission = 'read', resources }) =>
    Effect.succeed(
      resources.map(({ moduleId: owner, resourceId, resourceType: type }) => ({
        decision: permission === 'write' ? resourceWriteDecision : resourceDecision,
        key: `${owner}:${type}:${resourceId}`,
      })),
    ),
  tenants: ({ tenantIds }) =>
    Effect.succeed(tenantIds.map((key) => ({ decision: moduleDecision, key }))),
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
      return Effect.succeed(Redacted.make(authorization));
    },
    moduleStates: {
      getTenantModuleStates: (_tenantId: string, moduleIds: readonly string[]) =>
        Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state }))),
    },
  };
};

const providerKeys = Array.from({ length: 6 }, (_, index) => `property.registry.search-${index}`);
const concurrentCatalog = () => {
  const [contract] = catalog().contracts;
  if (contract === undefined) {
    throw new Error('The test catalog must include one installed contract');
  }
  return buildInstalledModuleCatalog([
    {
      contract: {
        ...contract,
        manifest: {
          ...contract.manifest,
          publicSurface: {
            ...contract.manifest.publicSurface,
            search: providerKeys.map((key) => ({
              accessFiltering: 'resource_permission' as const,
              key,
              owningModuleId: moduleId,
              resourceType,
            })),
            shellContributions: {
              ...contract.manifest.publicSurface.shellContributions,
              search: providerKeys.map((searchKey) => ({
                contributionKey: `${searchKey}.contribution`,
                entrypoint: { ...entrypoint('search'), entrypointKey: searchKey },
                searchKey,
              })),
            },
          },
        },
      },
      expectedAppId: 'property-registry',
    },
  ]);
};

for (const phase of ['permission', 'assertion', 'provider'] as const) {
  for (const cancel of [false, true]) {
    test(`search bounds ${phase} work to four and ${cancel ? 'cancels queued work' : 'preserves advertised order'}`, async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const gates = yield* Effect.forEach(providerKeys, () => Deferred.make<void>());
          const started: number[] = [];
          let active = 0;
          let peak = 0;
          let permissions = 0;
          let assertions = 0;
          let providerCalls = 0;
          const block = (index: number) =>
            Effect.gen(function* () {
              const gate = gates[index];
              if (gate === undefined) {
                return yield* Effect.die('Missing provider gate');
              }
              started.push(index);
              active += 1;
              peak = Math.max(peak, active);
              yield* Deferred.await(gate).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    active -= 1;
                  }),
                ),
              );
            });
          const baseline = dependencies();
          const search = makeShellSearch(
            {
              ...baseline,
              catalog: Effect.succeed(concurrentCatalog()),
              contextAccess: {
                ...baseline.contextAccess,
                modules: (input) =>
                  Effect.gen(function* () {
                    const index = permissions++;
                    if (phase === 'permission') {
                      yield* block(index);
                    }
                    return yield* baseline.contextAccess.modules(input);
                  }),
              },
              issueAssertion: () =>
                Effect.gen(function* () {
                  const index = assertions++;
                  expect(permissions).toBe(6);
                  if (phase === 'assertion') {
                    yield* block(index);
                  }
                  return `Bearer ${index}`;
                }),
            },
            {
              search: ({ searchKey, authorization }) =>
                Effect.gen(function* () {
                  providerCalls += 1;
                  const index = providerKeys.indexOf(searchKey);
                  expect(authorization).toBe(`Bearer ${index}`);
                  if (phase === 'provider') {
                    yield* block(index);
                  }
                  if (index === 1) {
                    return yield* Effect.fail(new ShellProviderUnavailableError());
                  }
                  return [{ ref, title: `Provider ${index}` }];
                }),
            },
          );
          const fiber = yield* search.search(context, 'unit').pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          expect(started).toEqual([0, 1, 2, 3]);
          expect(active).toBe(4);
          if (cancel) {
            yield* Fiber.interrupt(fiber);
            expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
            expect(started).toEqual([0, 1, 2, 3]);
            expect(active).toBe(0);
            expect(providerCalls).toBe(phase === 'provider' ? 4 : 0);
            return;
          }
          // Finish later providers first; duplicate precedence must remain catalog-ordered.
          for (const index of [3, 4, 5, 2, 1, 0]) {
            const gate = gates[index];
            if (gate === undefined) {
              return yield* Effect.die('Missing provider gate');
            }
            yield* Deferred.succeed(gate, undefined);
            yield* Effect.yieldNow;
          }
          expect(yield* Fiber.join(fiber)).toEqual({
            partial: true,
            results: [{ kind: 'resource', ref, title: 'Provider 5' }],
          });
          expect(started).toEqual([0, 1, 2, 3, 4, 5]);
          expect(peak).toBe(4);
          expect(active).toBe(0);
        }),
      );
    });
  }
}

test('search treats empty input as empty without touching providers', async () => {
  let calls = 0;
  const search = makeShellSearch(dependencies(), {
    search: () => {
      calls += 1;
      return Effect.succeed([]);
    },
  });
  await expect(Effect.runPromise(search.search(context, '   '))).resolves.toEqual({
    partial: false,
    results: [],
  });
  expect(calls).toBe(0);
});

test('search keeps an eligible provider with zero candidates as a successful empty result', async () => {
  const baseline = dependencies();
  const result = await Effect.runPromise(
    makeShellSearch(
      {
        ...baseline,
        contextAccess: {
          ...baseline.contextAccess,
          resources: () => Effect.die('empty results must not authorize an empty resource batch'),
        },
      },
      { search: () => Effect.succeed([]) },
    ).search(context, 'unit'),
  );
  expect(result).toEqual({ partial: false, results: [] });
});

test('search filters resource denials and reports partial provider failure', async () => {
  const result = await Effect.runPromise(
    makeShellSearch(dependencies('active', 'allowed', 'denied'), {
      search: () => Effect.succeed([{ ref, title: 'Unit 1' }]),
    }).search(context, ' unit '),
  );
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
  await expect(Effect.runPromise(partial.search(context, 'unit'))).resolves.toEqual({
    partial: true,
    results: [{ kind: 'resource', ref, title: 'Unit 1' }],
  });
});

test('tenant-scoped Party search needs no Legal Entity, forwards declared filters and preserves identity metadata', async () => {
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
                authorization: { kind: 'context_permission' as const, permission: 'module.access' },
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
  const partyCatalog = buildInstalledModuleCatalog([
    { contract: partyContract, expectedAppId: 'party-registry' },
  ]);
  const calls: unknown[] = [];
  const baseline = dependencies();
  const result = await Effect.runPromise(
    makeShellSearch(
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
    ).search(tenantContext, { includeArchived: true, query: ' party ', role: 'CUSTOMER' }),
  );

  expect(calls[0]).toEqual({ permission: 'read_party_identity', tenantIds: [tenantId] });
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
});

test('search fails only when every eligible provider fails', async () => {
  const effect = makeShellSearch(dependencies(), {
    search: () => Effect.fail(new ShellProviderUnavailableError()),
  }).search(context, 'unit');
  await expect(Effect.runPromise(effect)).rejects.toBeInstanceOf(ShellProviderUnavailableError);
});

test('Counterparty search preserves both identities, selected scope, roles and collision metadata', async () => {
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
  const result = await Effect.runPromise(
    search.search(context, { includeArchived: true, query: 'canonical', role: 'CUSTOMER' }),
  );
  expect(calls[0]).toMatchObject({ includeArchived: true, role: 'CUSTOMER' });
  expect(result).toEqual({
    partial: false,
    results: [{ ...value, kind: 'counterparty', title: 'Canonical Party' }],
  });
  expect(await Effect.runPromise(search.search(tenantContext, 'canonical'))).toEqual({
    partial: false,
    results: [],
  });
  expect(calls).toHaveLength(1);
  const baseline = dependencies();
  const redacted = await Effect.runPromise(
    makeShellSearch(
      {
        ...baseline,
        catalog: Effect.succeed(filteredCatalog),
        contextAccess: {
          ...baseline.contextAccess,
          resources: ({ resources }) =>
            Effect.succeed(
              resources.map((resource) => ({
                decision:
                  resource.resourceId === 'unit-2' ? ('denied' as const) : ('allowed' as const),
                key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
              })),
            ),
        },
      },
      { search: () => Effect.succeed([value]) },
    ).search(context, 'canonical'),
  );
  expect(JSON.stringify(redacted)).not.toContain('unit-2');
  expect(redacted.results[0]).not.toHaveProperty('collision');
});

test('treats a missing tenant module-state record as hidden rather than authorization uncertainty', async () => {
  let calls = 0;
  const hiddenDependencies = {
    ...dependencies(),
    moduleStates: { getTenantModuleStates: () => Effect.succeed([]) },
  };
  await expect(
    Effect.runPromise(
      makeShellSearch(hiddenDependencies, {
        search: () => {
          calls += 1;
          return Effect.succeed([{ ref, title: 'Unit 1' }]);
        },
      }).search(context, 'unit'),
    ),
  ).resolves.toEqual({ partial: false, results: [] });
  const gateway = {
    detail: () => {
      calls += 1;
      return Effect.succeed({ fields: [], title: 'Unit 1' });
    },
    timeline: () => Effect.succeed({ entries: [], projectionLagging: false }),
  };
  await expect(
    Effect.runPromise(makeShellResourceDetail(hiddenDependencies, gateway).resolve(context, ref)),
  ).resolves.toEqual({ outcome: 'not_found' });
  await expect(Effect.runPromise(attachShellMedia(context, ref))).resolves.toEqual({
    outcome: 'unavailable',
  });
  expect(calls).toBe(0);
});

test('search fails closed for module or resource authorization uncertainty', async () => {
  await expect(
    Effect.runPromise(
      makeShellSearch(dependencies('active', 'unavailable'), {
        search: () => Effect.succeed([{ ref, title: 'Unit 1' }]),
      }).search(context, 'unit'),
    ),
  ).rejects.toBeInstanceOf(ShellProviderUnavailableError);
  await expect(
    Effect.runPromise(
      makeShellSearch(dependencies('active', 'allowed', 'unavailable'), {
        search: () => Effect.succeed([{ ref, title: 'Unit 1' }]),
      }).search(context, 'unit'),
    ),
  ).rejects.toBeInstanceOf(ShellProviderUnavailableError);
});

test('resource detail applies catalog, state, module and resource gates before providers', async () => {
  let calls = 0;
  const provider = {
    detail: () => {
      calls += 1;
      return Effect.succeed({ fields: [], title: 'Unit 1' });
    },
    timeline: () => Effect.succeed({ entries: [], projectionLagging: false }),
  };
  expect(
    await Effect.runPromise(
      makeShellResourceDetail(dependencies('inactive'), provider).resolve(context, ref),
    ),
  ).toEqual({ outcome: 'not_found' });
  expect(
    await Effect.runPromise(
      makeShellResourceDetail(dependencies('active', 'denied'), provider).resolve(context, ref),
    ),
  ).toEqual({ outcome: 'forbidden' });
  expect(
    await Effect.runPromise(
      makeShellResourceDetail(dependencies('active', 'allowed', 'unavailable'), provider).resolve(
        context,
        ref,
      ),
    ),
  ).toEqual({ outcome: 'unavailable' });
  expect(calls).toBe(0);
});

test('resource detail sorts an authorized timeline and exposes projection lag', async () => {
  const result = await Effect.runPromise(
    makeShellResourceDetail(dependencies(), {
      detail: () => Effect.succeed({ fields: [], title: 'Unit 1' }),
      timeline: () =>
        Effect.succeed({
          entries: [
            { occurredAt: '2026-01-01T00:00:00Z', summary: 'Created', timelineEntryId: '1' },
            { occurredAt: '2026-02-01T00:00:00Z', summary: 'Updated', timelineEntryId: '2' },
          ],
          projectionLagging: true,
        }),
    }).resolve(context, ref),
  );
  expect(result).toEqual({
    detail: { fields: [], title: 'Unit 1' },
    media: { enabled: false, reason: 'unavailable' },
    outcome: 'resolved',
    projectionLagging: true,
    timeline: [
      { occurredAt: '2026-02-01T00:00:00Z', summary: 'Updated', timelineEntryId: '2' },
      { occurredAt: '2026-01-01T00:00:00Z', summary: 'Created', timelineEntryId: '1' },
    ],
  });
});

test('media affordance remains unavailable until a generated Action exists', async () => {
  const provider = {
    detail: () => Effect.succeed({ fields: [], title: 'Unit 1' }),
    timeline: () => Effect.succeed({ entries: [], projectionLagging: false }),
  };
  await expect(
    Effect.runPromise(
      makeShellResourceDetail(dependencies('read_only'), provider).resolve(context, ref),
    ),
  ).resolves.toMatchObject({ media: { enabled: false, reason: 'read_only' } });
  await expect(
    Effect.runPromise(
      makeShellResourceDetail(
        dependencies('active', 'allowed', 'allowed', 'denied'),
        provider,
      ).resolve(context, ref),
    ),
  ).resolves.toMatchObject({ media: { enabled: false, reason: 'unavailable' } });
  await expect(
    Effect.runPromise(makeShellResourceDetail(dependencies(), provider).resolve(context, ref)),
  ).resolves.toMatchObject({ media: { enabled: false, reason: 'unavailable' } });
});

test('media endpoint cannot invoke a provider mutation', async () => {
  await expect(Effect.runPromise(attachShellMedia(context, ref))).resolves.toEqual({
    outcome: 'unavailable',
  });
});

test('redacts provider assertions in memory and unwraps them only at the request header sink', async () => {
  const authorizations: Redacted.Redacted<string>[] = [];
  const requests: Request[] = [];
  const result = await Effect.runPromise(
    makeShellResourceDetail(dependencies(), {
      detail: ({ authorization }) => {
        authorizations.push(authorization);
        requests.push(
          new Request('https://property.example/resource', {
            headers: { authorization: Redacted.value(authorization) },
          }),
        );
        return Effect.succeed({ fields: [], title: 'Unit 1' });
      },
      timeline: ({ authorization }) => {
        authorizations.push(authorization);
        requests.push(
          new Request('https://property.example/timeline', {
            headers: { authorization: Redacted.value(authorization) },
          }),
        );
        return Effect.succeed({ entries: [], projectionLagging: false });
      },
    }).resolve(context, ref),
  );
  expect(result.outcome).toBe('resolved');
  expect(authorizations).toHaveLength(2);
  for (const authorization of authorizations) {
    expect(Redacted.isRedacted(authorization)).toBe(true);
    expect(String(authorization)).toBe('<redacted>');
    expect(JSON.stringify({ authorization })).toBe('{"authorization":"<redacted>"}');
  }
  expect(JSON.stringify({ authorizations })).not.toContain('Bearer test-0');
  expect(JSON.stringify({ authorizations })).not.toContain('Bearer test-1');
  expect(requests.map((request) => request.headers.get('authorization'))).toEqual([
    'Bearer test-0',
    'Bearer test-1',
  ]);
});
