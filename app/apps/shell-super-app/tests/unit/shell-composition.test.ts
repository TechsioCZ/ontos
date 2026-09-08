import { expect, it } from '@app/effect-rstest';
import { buildInstalledModuleCatalog, resolveInstalledModuleCatalog } from '@app/core-runtime';
import type {
  ContextAccessDecision,
  ContextAccessService,
  InstalledModuleCatalog,
  TenantModuleState,
} from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { makeShellComposition } from '../../api/modules/shell-composition.ts';
import { ShellCompositionSchema } from '../../shared/api.ts';

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
              authorization: { kind: 'context_permission', permission: 'module_access' },
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
              authorization: { kind: 'context_permission', permission: 'module_access' },
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

const numberLikeOrder = (value: number): number => {
  const runtimeValue: unknown = Reflect.construct(Number, [value]);
  // SAFETY: This test deliberately reproduces the validated number-like value observed at runtime.
  return runtimeValue as number;
};

const catalogWithNumberLikeOrder = (): InstalledModuleCatalog => {
  const base = catalog();
  return {
    ...base,
    contracts: base.contracts.map((contract) => ({
      ...contract,
      manifest: {
        ...contract.manifest,
        publicSurface: {
          ...contract.manifest.publicSurface,
          shellContributions: {
            ...contract.manifest.publicSurface.shellContributions,
            navigation: contract.manifest.publicSurface.shellContributions.navigation.map(
              (contribution) => ({
                ...contribution,
                order: numberLikeOrder(contribution.order),
              }),
            ),
          },
        },
      },
    })),
  };
};

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
      authorization: { kind: 'context_permission', permission: 'module_access' },
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
): ContextAccessService => ({
  legalEntities: () => Effect.succeed([]),
  modules: ({ moduleIds }) => {
    onBatch?.(moduleIds);
    return Effect.succeed(moduleIds.map((key) => ({ decision: decisions[key] ?? 'denied', key })));
  },
  resources: () => Effect.succeed([]),
  tenants: () => Effect.succeed([]),
});

const context = { legalEntityId, principalId, tenantId } as const;

it.effect('composes one deterministic state and permission batch with lifecycle affordances', () =>
  Effect.gen(function* composesOneDeterministicStateAndPermission() {
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
    const result = yield* composition.compose(context);
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
      unavailableDeployments: [],
    });
    expect({ permissionBatches, stateBatches }).toEqual({ permissionBatches: 1, stateBatches: 1 });
  }),
);

it.effect('keeps healthy navigation and exposes failed installed deployments separately', () =>
  Effect.gen(function* keepsHealthyNavigationAndExposesFailed() {
    const degradedCatalog = resolveInstalledModuleCatalog([
      {
        contract: deployment('documents-center', 'documents.center', 'Documents', 10),
        expectedAppId: 'documents-center',
        outcome: 'fetched',
      },
      {
        expectedAppId: 'property-registry',
        outcome: 'failed',
        reason: 'timeout',
      },
    ]);
    const result = yield* makeShellComposition({
      catalog: Effect.succeed(degradedCatalog),
      contextAccess: contextAccess({ 'documents.center': 'allowed' }),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' }))),
      },
    }).compose(context);

    expect(result.state).toBe('available');
    if (result.state !== 'available') {
      throw new Error('expected an available degraded composition');
    }
    expect(result.navigation.map(({ moduleId }) => moduleId)).toEqual(['documents.center']);
    expect(result.unavailableDeployments).toEqual([
      { appId: 'property-registry', reason: 'timeout', status: 'unavailable' },
    ]);
    expect(() => Schema.decodeUnknownSync(ShellCompositionSchema)(result)).not.toThrow();
  }),
);

it.effect('normalizes number-like module order before returning the public composition', () =>
  Effect.gen(function* normalizesNumberLikeModuleOrderBefore() {
    const result = yield* makeShellComposition({
      catalog: Effect.succeed(catalogWithNumberLikeOrder()),
      contextAccess: contextAccess({
        'documents.center': 'allowed',
        'property.registry': 'allowed',
      }),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' }))),
      },
    }).compose(context);

    expect(result.navigation.map(({ order }) => order)).toEqual([10, 20]);
    expect(result.navigation.every(({ order }) => Object.is(order, Number(order)))).toBe(true);
    expect(() => Schema.decodeUnknownSync(ShellCompositionSchema)(result)).not.toThrow();
  }),
);

it.effect.each(['inactive', 'suspended', 'quarantined', 'archived'] as const)(
  'hides the %s lifecycle from normal navigation',
  (state) =>
    Effect.gen(function* inactive() {
      const result = yield* makeShellComposition({
        catalog: Effect.succeed(catalog()),
        contextAccess: contextAccess({
          'documents.center': 'allowed',
          'property.registry': 'allowed',
        }),
        moduleStates: {
          getTenantModuleStates: (_tenantId, moduleIds) =>
            Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state }))),
        },
      }).compose(context);
      expect(result).toEqual({ navigation: [], state: 'available', unavailableDeployments: [] });
    }),
);

it.effect('omits definite denial while preserving unavailable authorization as disabled', () =>
  Effect.gen(function* omitsDefiniteDenialWhilePreservingUnavailable() {
    const result = yield* makeShellComposition({
      catalog: Effect.succeed(catalog()),
      contextAccess: contextAccess({
        'documents.center': 'denied',
        'property.registry': 'unavailable',
      }),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' }))),
      },
    }).compose(context);
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
  }),
);

it.effect(
  'resolves direct targets independently with exhaustive safe outcomes and historical reads',
  () =>
    Effect.gen(function* resolvesDirectTargetsIndependentlyWithExhaustive() {
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
      const resolved = yield* composition.resolveModuleTarget(context, {
        moduleId: 'property.registry',
      });
      expect(resolved.outcome).toBe('resolved');
      decision = 'denied';
      const forbidden = yield* composition.resolveModuleTarget(context, {
        moduleId: 'property.registry',
      });
      expect(forbidden.outcome).toBe('forbidden');
      decision = 'unavailable';
      const unavailable = yield* composition.resolveModuleTarget(context, {
        moduleId: 'property.registry',
      });
      expect(unavailable.outcome).toBe('unavailable');
      decision = 'allowed';
      state = 'archived';
      const archived = yield* composition.resolveModuleTarget(context, {
        moduleId: 'property.registry',
      });
      expect(archived.outcome).toBe('not_found');
      const historical = yield* composition.resolveModuleTarget(context, {
        access: 'historical_read',
        moduleId: 'property.registry',
      });
      expect(historical.outcome).toBe('resolved');
      const selectionRequired = yield* composition.resolveModuleTarget(
        { principalId, tenantId },
        { moduleId: 'property.registry' },
      );
      expect(selectionRequired.outcome).toBe('selection_required');
      const missing = yield* composition.resolveModuleTarget(context, {
        moduleId: 'missing.module',
      });
      expect(missing.outcome).toBe('not_found');
    }),
);

it.effect.each(['active', 'read_only', 'deprecated'] as const)(
  'resolves the exact page entrypoint in the %s lifecycle without changing module landing',
  (state) =>
    Effect.gen(function* active() {
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
      const landing = yield* composition.resolveModuleTarget(context, {
        moduleId: 'property.registry',
      });
      const customers = yield* composition.resolveModuleTarget(context, {
        entrypointKey: 'property.registry.page.customers',
        moduleId: 'property.registry',
      });
      expect(landing).toMatchObject({
        outcome: 'resolved',
        page: { componentKey: 'property.registry.page-home' },
      });
      expect(customers).toMatchObject({
        outcome: 'resolved',
        page: { componentKey: 'property.registry.page-customers' },
        writable: state === 'active',
      });
      const missingPage = yield* composition.resolveModuleTarget(context, {
        entrypointKey: 'property.registry.page.missing',
        moduleId: 'property.registry',
      });
      expect(missingPage.outcome).toBe('not_found');
      const crossOwnedPage = yield* composition.resolveModuleTarget(context, {
        entrypointKey: 'documents.center.page.home',
        moduleId: 'property.registry',
      });
      expect(crossOwnedPage.outcome).toBe('not_found');
    }),
);
