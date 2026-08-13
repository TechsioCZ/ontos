/* eslint-disable unicorn/no-await-expression-member -- Each assertion resolves an independent direct-target request. */
import { expect, test } from '@rstest/core';
import { buildInstalledModuleCatalog } from '@app/core-runtime';
import type {
  ContextAccessDecision,
  ContextAccessShape,
  InstalledModuleCatalog,
  TenantModuleState,
} from '@app/core-runtime';
import { Effect } from 'effect';
import { makeShellComposition } from '../../api/modules/shell-composition.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';

const deployment = (appId: string, moduleId: string, displayName: string, order: number) => ({
  deployment: { appId, buildMarker: `build-${appId}` },
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
      description: `${displayName} capability.`,
      displayName,
      id: moduleId,
      implementedAs: 'ultramodern_microvertical',
      kind: 'business_module',
    },
    publicSurface: {
      actions: [],
      api: [],
      components: [
        {
          expose: './PageHome',
          key: `${moduleId}.page-home`,
          mfBoundaryId: `vertical${appId.replaceAll('-', '')}`,
        },
      ],
      events: [],
      reports: [],
      resourceTypes: [],
      search: [],
      shellContributions: {
        mediaAttachments: [],
        navigation: [
          {
            contributionKey: `${moduleId}.navigation.home`,
            entrypoint: {
              access: 'read',
              entrypointKey: `${moduleId}.page.home`,
              moduleKey: moduleId,
              role: 'page',
              scope: 'tenant',
            },
            groupKey: 'shell.navigation.modules',
            order,
            pageKey: `${moduleId}.page.home`,
          },
        ],
        pages: [
          {
            componentKey: `${moduleId}.page-home`,
            contributionKey: `${moduleId}.page.home`,
            entrypoint: {
              access: 'read',
              entrypointKey: `${moduleId}.page.home`,
              moduleKey: moduleId,
              role: 'page',
              scope: 'tenant',
            },
            routePath: `/${appId}`,
          },
        ],
        publicComponents: [],
        reports: [],
        resourceDetails: [],
        search: [],
        timelines: [],
      },
    },
  },
  runtime: { outboxSubscriptions: [] },
  schemaVersion: '2',
});

const catalog = (): InstalledModuleCatalog =>
  buildInstalledModuleCatalog([
    {
      contract: deployment('property-registry', 'property.registry', 'Property', 20),
      expectedAppId: 'property-registry',
    },
    {
      contract: deployment('documents-center', 'documents.center', 'Documents', 10),
      expectedAppId: 'documents-center',
    },
  ]);

const catalogWithSecondPropertyPage = (): InstalledModuleCatalog => {
  const property = deployment('property-registry', 'property.registry', 'Property', 20);
  property.manifest.publicSurface.components.push({
    expose: './PageCustomers',
    key: 'property.registry.page-customers',
    mfBoundaryId: 'verticalpropertyregistry',
  });
  property.manifest.publicSurface.shellContributions.pages.push({
    componentKey: 'property.registry.page-customers',
    contributionKey: 'property.registry.page.customers',
    entrypoint: {
      access: 'read',
      entrypointKey: 'property.registry.page.customers',
      moduleKey: 'property.registry',
      role: 'page',
      scope: 'tenant',
    },
    routePath: '/property-registry/customers',
  });
  return buildInstalledModuleCatalog([
    { contract: property, expectedAppId: 'property-registry' },
    {
      contract: deployment('documents-center', 'documents.center', 'Documents', 10),
      expectedAppId: 'documents-center',
    },
  ]);
};

const contextAccess = (
  decisions: Readonly<Record<string, ContextAccessDecision>>,
  onBatch?: (moduleIds: readonly string[]) => void,
): ContextAccessShape => ({
  legalEntities: () => Effect.succeed([]),
  modules: ({ moduleIds }) => {
    onBatch?.(moduleIds);
    return Effect.succeed(moduleIds.map((key) => ({ decision: decisions[key] ?? 'denied', key })));
  },
  resources: () => Effect.succeed([]),
});

const context = { legalEntityId, principalId, tenantId } as const;

test('composes one deterministic state and permission batch with lifecycle affordances', async () => {
  let stateBatches = 0;
  let permissionBatches = 0;
  const composition = makeShellComposition({
    catalog: Effect.succeed(catalog()),
    contextAccess: contextAccess(
      { 'documents.center': 'allowed', 'property.registry': 'allowed' },
      () => (permissionBatches += 1),
    ),
    moduleStates: {
      getTenantModuleStates: (_tenantId, moduleIds) => {
        stateBatches += 1;
        return Effect.succeed(
          moduleIds.map((moduleKey) => ({
            moduleKey,
            state:
              moduleKey === 'documents.center' ? ('read_only' as const) : ('deprecated' as const),
          })),
        );
      },
    },
  });
  const result = await Effect.runPromise(composition.compose(context));
  expect(result).toEqual({
    navigation: [
      {
        appId: 'documents-center',
        enabled: true,
        groupKey: 'shell.navigation.modules',
        href: '/documents-center',
        label: 'Documents',
        moduleId: 'documents.center',
        order: 10,
        state: 'read_only',
        unavailable: false,
        writable: false,
      },
      {
        appId: 'property-registry',
        enabled: true,
        groupKey: 'shell.navigation.modules',
        href: '/property-registry',
        label: 'Property',
        moduleId: 'property.registry',
        order: 20,
        state: 'deprecated',
        unavailable: false,
        writable: false,
      },
    ],
    state: 'available',
  });
  expect({ permissionBatches, stateBatches }).toEqual({ permissionBatches: 1, stateBatches: 1 });
});

test.each(['inactive', 'suspended', 'quarantined', 'archived'] as const)(
  'hides the %s lifecycle from normal navigation',
  async (state) => {
    const result = await Effect.runPromise(
      makeShellComposition({
        catalog: Effect.succeed(catalog()),
        contextAccess: contextAccess({
          'documents.center': 'allowed',
          'property.registry': 'allowed',
        }),
        moduleStates: {
          getTenantModuleStates: (_tenantId, moduleIds) =>
            Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state }))),
        },
      }).compose(context),
    );
    expect(result).toEqual({ navigation: [], state: 'available' });
  },
);

test('omits definite denial while preserving unavailable authorization as disabled', async () => {
  const result = await Effect.runPromise(
    makeShellComposition({
      catalog: Effect.succeed(catalog()),
      contextAccess: contextAccess({
        'documents.center': 'denied',
        'property.registry': 'unavailable',
      }),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' }))),
      },
    }).compose(context),
  );
  expect(result.state).toBe('available');
  expect(result.navigation).toEqual([
    {
      appId: 'property-registry',
      enabled: false,
      groupKey: 'shell.navigation.modules',
      label: 'Property',
      moduleId: 'property.registry',
      order: 20,
      state: 'active',
      unavailable: true,
      writable: true,
    },
  ]);
});

test('resolves direct targets independently with exhaustive safe outcomes and historical reads', async () => {
  let state: TenantModuleState = 'active';
  let decision: ContextAccessDecision = 'allowed';
  const mutableAccess = contextAccess({});
  const composition = makeShellComposition({
    catalog: Effect.succeed(catalog()),
    contextAccess: {
      ...mutableAccess,
      modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision, key }))),
    },
    moduleStates: {
      getTenantModuleStates: (_tenantId, moduleIds) =>
        Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state }))),
    },
  });
  expect(
    (
      await Effect.runPromise(
        composition.resolveModuleTarget(context, { moduleId: 'property.registry' }),
      )
    ).outcome,
  ).toBe('resolved');
  decision = 'denied';
  expect(
    (
      await Effect.runPromise(
        composition.resolveModuleTarget(context, { moduleId: 'property.registry' }),
      )
    ).outcome,
  ).toBe('forbidden');
  decision = 'unavailable';
  expect(
    (
      await Effect.runPromise(
        composition.resolveModuleTarget(context, { moduleId: 'property.registry' }),
      )
    ).outcome,
  ).toBe('unavailable');
  decision = 'allowed';
  state = 'archived';
  expect(
    (
      await Effect.runPromise(
        composition.resolveModuleTarget(context, { moduleId: 'property.registry' }),
      )
    ).outcome,
  ).toBe('not_found');
  expect(
    (
      await Effect.runPromise(
        composition.resolveModuleTarget(context, {
          access: 'historical_read',
          moduleId: 'property.registry',
        }),
      )
    ).outcome,
  ).toBe('resolved');
  expect(
    (
      await Effect.runPromise(
        composition.resolveModuleTarget(
          { principalId, tenantId },
          { moduleId: 'property.registry' },
        ),
      )
    ).outcome,
  ).toBe('selection_required');
  expect(
    (
      await Effect.runPromise(
        composition.resolveModuleTarget(context, { moduleId: 'missing.module' }),
      )
    ).outcome,
  ).toBe('not_found');
});

test.each(['active', 'read_only', 'deprecated'] as const)(
  'resolves the exact page entrypoint in the %s lifecycle without changing module landing',
  async (state) => {
    const composition = makeShellComposition({
      catalog: Effect.succeed(catalogWithSecondPropertyPage()),
      contextAccess: contextAccess({
        'documents.center': 'allowed',
        'property.registry': 'allowed',
      }),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state }))),
      },
    });
    const landing = await Effect.runPromise(
      composition.resolveModuleTarget(context, { moduleId: 'property.registry' }),
    );
    const customers = await Effect.runPromise(
      composition.resolveModuleTarget(context, {
        entrypointKey: 'property.registry.page.customers',
        moduleId: 'property.registry',
      }),
    );
    expect(landing).toMatchObject({
      outcome: 'resolved',
      page: { componentKey: 'property.registry.page-home' },
    });
    expect(customers).toMatchObject({
      outcome: 'resolved',
      page: { componentKey: 'property.registry.page-customers' },
      writable: state === 'active',
    });
    expect(
      (
        await Effect.runPromise(
          composition.resolveModuleTarget(context, {
            entrypointKey: 'property.registry.page.missing',
            moduleId: 'property.registry',
          }),
        )
      ).outcome,
    ).toBe('not_found');
    expect(
      (
        await Effect.runPromise(
          composition.resolveModuleTarget(context, {
            entrypointKey: 'documents.center.page.home',
            moduleId: 'property.registry',
          }),
        )
      ).outcome,
    ).toBe('not_found');
  },
);
