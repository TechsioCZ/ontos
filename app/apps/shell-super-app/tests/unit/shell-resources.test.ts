/* eslint-disable typescript/no-non-null-assertion -- The synthetic catalog fixture always installs its single declared contract. */
import { expect, test } from '@rstest/core';
import { buildInstalledModuleCatalog } from '@app/core-runtime';
import type {
  ContextAccessDecision,
  ContextAccessShape,
  InstalledModuleCatalog,
  TenantModuleState,
} from '@app/core-runtime';
import { Effect } from 'effect';
import {
  makeShellMediaAttachment,
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
const ref = { moduleId, resourceId: 'unit-1', resourceType } as const;
const entrypoint = (role: 'api' | 'search', access: 'read' | 'write' = 'read') => ({
  access,
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
): ContextAccessShape => ({
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
  const contract = installed.contracts[0]!;
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
    results: [{ ref, title: 'Unit 1' }],
  });
});

test('search fails only when every eligible provider fails', async () => {
  const effect = makeShellSearch(dependencies(), {
    search: () => Effect.fail(new ShellProviderUnavailableError()),
  }).search(context, 'unit');
  await expect(Effect.runPromise(effect)).rejects.toBeInstanceOf(ShellProviderUnavailableError);
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
  await expect(Effect.runPromise(makeShellMediaAttachment().attach(context, ref))).resolves.toEqual(
    { outcome: 'unavailable' },
  );
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
  await expect(Effect.runPromise(makeShellMediaAttachment().attach(context, ref))).resolves.toEqual(
    { outcome: 'unavailable' },
  );
});

test('acquires a fresh audience-scoped assertion for each provider attempt', async () => {
  const authorizations: string[] = [];
  const result = await Effect.runPromise(
    makeShellResourceDetail(dependencies(), {
      detail: ({ authorization }) => {
        authorizations.push(authorization);
        return Effect.succeed({ fields: [], title: 'Unit 1' });
      },
      timeline: ({ authorization }) => {
        authorizations.push(authorization);
        return Effect.succeed({ entries: [], projectionLagging: false });
      },
    }).resolve(context, ref),
  );
  expect(result.outcome).toBe('resolved');
  expect(authorizations).toEqual(['Bearer test-0', 'Bearer test-1']);
});
