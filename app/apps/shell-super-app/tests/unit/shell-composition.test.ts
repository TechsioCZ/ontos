import type { ContextAccessDecision, ContextAccessService, TenantModuleState } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import {
  InstalledModuleCatalogUnavailableError,
  makeInstalledModuleCatalogLoader,
} from '../../api/modules/installed-module-catalog.ts';
import { makeShellComposition, ShellCompositionUnavailableError } from '../../api/modules/shell-composition.ts';
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
      supportedStates: ['inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'],
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
              authorization: {
                kind: 'context_permission',
                permission: 'module_access',
              },
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
              authorization: {
                kind: 'context_permission',
                permission: 'module_access',
              },
              entrypointKey: `${moduleId}.page.home`,
              moduleKey: moduleId,
              role: 'page',
              scope: 'tenant',
            },
            expose: './PageHome',
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

const catalog = () =>
  makeInstalledModuleCatalogLoader(
    makeCompositionSnapshot([
      deployment('property-registry', 'property.registry', 'Property', 20),
      deployment('documents-center', 'documents.center', 'Documents', 10),
    ]),
  );

const numberLikeOrder = (value: number): number => {
  const runtimeValue: unknown = Reflect.construct(Number, [value]);
  // SAFETY: This test deliberately reproduces the validated number-like value observed at runtime.
  return runtimeValue as number;
};

const catalogWithNumberLikeOrder = () =>
  Effect.gen(function* numberLikeCatalog() {
    const base = yield* catalog();
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
              navigation: contract.manifest.publicSurface.shellContributions.navigation.map((contribution) => ({
                ...contribution,
                order: numberLikeOrder(contribution.order),
              })),
            },
          },
        },
      })),
    };
  });

const catalogWithSecondPropertyPage = (routePath = '/property-registry/customers') => {
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
      authorization: {
        kind: 'context_permission',
        permission: 'module_access',
      },
      entrypointKey: 'property.registry.page.customers',
      moduleKey: 'property.registry',
      role: 'page',
      scope: 'tenant',
    },
    expose: './PageCustomers',
    routePath,
  });
  return makeInstalledModuleCatalogLoader(
    makeCompositionSnapshot([property, deployment('documents-center', 'documents.center', 'Documents', 10)]),
  );
};

const catalogWithContactPages = (
  pages: readonly { readonly expose: string; readonly key: string; readonly routePath: string }[],
) => {
  const party = deployment('party-registry', 'party.registry', 'Contacts', 10);
  for (const { expose, key, routePath } of pages) {
    const componentKey = `party.registry.page-${key}`;
    const contributionKey = `party.registry.page.${key}`;
    party.manifest.publicSurface.components.push({
      expose,
      key: componentKey,
      mfBoundaryId: 'verticalpartyregistry',
    });
    party.manifest.publicSurface.shellContributions.pages.push({
      componentKey,
      contributionKey,
      entrypoint: {
        access: 'read',
        authorization: {
          kind: 'context_permission',
          permission: 'module_access',
        },
        entrypointKey: contributionKey,
        moduleKey: 'party.registry',
        role: 'page',
        scope: 'tenant',
      },
      expose,
      routePath,
    });
  }
  return makeInstalledModuleCatalogLoader(makeCompositionSnapshot([party]));
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
    const approvedCatalog = yield* catalog();
    const composition = makeShellComposition({
      catalog: Effect.succeed(approvedCatalog),
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
              state: moduleKey === 'documents.center' ? ('read_only' as const) : ('deprecated' as const),
            })),
          );
        },
      },
    });
    const result = yield* composition.compose(context);
    expect(result).toEqual({
      compositionRevision: approvedCatalog.composition.revision,
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
    expect({ permissionBatches, stateBatches }).toEqual({
      permissionBatches: 1,
      stateBatches: 1,
    });
  }),
);

it.effect('fails closed before permissions or lifecycle state when complete approved authority is unavailable', () =>
  Effect.gen(function* refusesIncompleteAuthority() {
    let permissionBatches = 0;
    let stateBatches = 0;
    const failure = yield* makeShellComposition({
      catalog: Effect.fail(new InstalledModuleCatalogUnavailableError({ reason: 'approved snapshot unavailable' })),
      contextAccess: contextAccess({ 'documents.center': 'allowed' }, () => (permissionBatches += 1)),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) => {
          stateBatches += 1;
          return Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' })));
        },
      },
    })
      .compose(context)
      .pipe(Effect.flip);
    expect(failure).toBeInstanceOf(ShellCompositionUnavailableError);
    expect({ permissionBatches, stateBatches }).toEqual({ permissionBatches: 0, stateBatches: 0 });
  }),
);

it.effect('normalizes number-like module order before returning the public composition', () =>
  Effect.gen(function* normalizesNumberLikeModuleOrderBefore() {
    const result = yield* makeShellComposition({
      catalog: catalogWithNumberLikeOrder(),
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
      const approvedCatalog = yield* catalog();
      const result = yield* makeShellComposition({
        catalog: Effect.succeed(approvedCatalog),
        contextAccess: contextAccess({
          'documents.center': 'allowed',
          'property.registry': 'allowed',
        }),
        moduleStates: {
          getTenantModuleStates: (_tenantId, moduleIds) =>
            Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state }))),
        },
      }).compose(context);
      expect(result).toEqual({
        compositionRevision: approvedCatalog.composition.revision,
        navigation: [],
        state: 'available',
        unavailableDeployments: [],
      });
    }),
);

it.effect('omits definite denial while preserving unavailable authorization as disabled', () =>
  Effect.gen(function* omitsDefiniteDenialWhilePreservingUnavailable() {
    const result = yield* makeShellComposition({
      catalog: catalog(),
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

it.effect('resolves direct targets independently with exhaustive safe outcomes and historical reads', () =>
  Effect.gen(function* resolvesDirectTargetsIndependentlyWithExhaustive() {
    let state: TenantModuleState = 'active';
    let decision: ContextAccessDecision = 'allowed';
    const mutableAccess = contextAccess({});
    const composition = makeShellComposition({
      catalog: catalog(),
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
    expect(forbidden).not.toHaveProperty('federation');
    expect(forbidden).not.toHaveProperty('page');
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

it.effect('returns the approved release and safe named parameters for canonical routes', () =>
  Effect.gen(function* resolvesPinnedCanonicalPage() {
    const approvedCatalog = yield* catalogWithSecondPropertyPage('/property-registry/customers/:customerId');
    const composition = makeShellComposition({
      catalog: Effect.succeed(approvedCatalog),
      contextAccess: contextAccess({ 'property.registry': 'allowed' }),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' }))),
      },
    });
    const resolved = yield* composition.resolveModuleTarget(context, {
      canonicalPath: '/property-registry/customers/customer-123',
      compositionRevision: approvedCatalog.composition.revision,
    });
    const approvedModule = approvedCatalog.composition.modules.find(({ moduleId }) => moduleId === 'property.registry');
    if (approvedModule?.federation.execution !== 'browser') {
      throw new Error('expected approved browser release in fixture');
    }
    expect(resolved).toMatchObject({
      compositionRevision: approvedCatalog.composition.revision,
      federation: {
        expose: './PageCustomers',
        manifest: approvedModule.federation.manifest,
        remoteName: 'verticalpropertyregistry',
      },
      moduleId: 'property.registry',
      outcome: 'resolved',
      routeParameters: { customerId: 'customer-123' },
    });
  }),
);

it.effect.each([
  {
    canonicalPath: '/contacts/customers/create',
    expose: './PageCustomerCreate',
    key: 'customer-create',
    routeParameters: {},
    routePath: '/contacts/customers/create',
  },
  {
    canonicalPath: '/contacts/customers/customer-123',
    expose: './PageCustomerDetail',
    key: 'customer-detail',
    routeParameters: { customerId: 'customer-123' },
    routePath: '/contacts/customers/:customerId',
  },
  {
    canonicalPath: '/contacts/customers/customer-123/edit',
    expose: './PageCustomerEdit',
    key: 'customer-edit',
    routeParameters: { customerId: 'customer-123' },
    routePath: '/contacts/customers/:customerId/edit',
  },
  {
    canonicalPath: '/contacts/customers/create/edit',
    expose: './PageCustomerEdit',
    key: 'customer-edit',
    routeParameters: { customerId: 'create' },
    routePath: '/contacts/customers/:customerId/edit',
  },
])('resolves the declared customer page for %s', ({ canonicalPath, expose, key, routeParameters, routePath }) =>
  Effect.gen(function* resolvesCanonicalCustomerPage() {
    const approvedCatalog = yield* catalogWithContactPages([
      { expose: './PageCustomerDetail', key: 'customer-detail', routePath: '/contacts/customers/:customerId' },
      { expose: './PageCustomerCreate', key: 'customer-create', routePath: '/contacts/customers/create' },
      { expose: './PageCustomerEdit', key: 'customer-edit', routePath: '/contacts/customers/:customerId/edit' },
    ]);
    const resolved = yield* makeShellComposition({
      catalog: Effect.succeed(approvedCatalog),
      contextAccess: contextAccess({ 'party.registry': 'allowed' }),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' }))),
      },
    }).resolveModuleTarget(context, { canonicalPath, compositionRevision: approvedCatalog.composition.revision });
    expect(resolved).toMatchObject({
      compositionRevision: approvedCatalog.composition.revision,
      federation: { expose, remoteName: 'verticalpartyregistry' },
      moduleId: 'party.registry',
      outcome: 'resolved',
      page: {
        componentKey: `party.registry.page-${key}`,
        contributionKey: `party.registry.page.${key}`,
        expose,
        routePath,
      },
    });
    expect(resolved).toHaveProperty('routeParameters', routeParameters);
  }),
);

it.effect.each([false, true])('prefers an earlier static segment with reversed declaration order %s', (reverse) =>
  Effect.gen(function* prefersEarlierStaticSegment() {
    const pages = [
      { expose: './PageCategoryEdit', key: 'category-edit', routePath: '/contacts/:category/create/edit' },
      { expose: './PageCustomerAction', key: 'customer-action', routePath: '/contacts/customers/:customerId/:action' },
    ];
    const resolved = yield* makeShellComposition({
      catalog: catalogWithContactPages(reverse ? pages.toReversed() : pages),
      contextAccess: contextAccess({ 'party.registry': 'allowed' }),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' }))),
      },
    }).resolveModuleTarget(context, { canonicalPath: '/contacts/customers/create/edit' });
    expect(resolved).toMatchObject({
      federation: { expose: './PageCustomerAction' },
      outcome: 'resolved',
      page: { componentKey: 'party.registry.page-customer-action' },
      routeParameters: { action: 'edit', customerId: 'create' },
    });
  }),
);

it.effect('rejects ambiguous approved route authority before lifecycle or permission checks', () =>
  Effect.gen(function* refusesAmbiguousCanonicalPages() {
    let permissionBatches = 0;
    let stateBatches = 0;
    const ambiguousCatalog = catalogWithContactPages([
      { expose: './PageCustomerDetail', key: 'customer-detail', routePath: '/contacts/customers/:customerId' },
      { expose: './PageCustomerAlias', key: 'customer-alias', routePath: '/contacts/customers/:recordId' },
    ]);
    const failure = yield* makeShellComposition({
      catalog: ambiguousCatalog,
      contextAccess: contextAccess({ 'party.registry': 'allowed' }, () => (permissionBatches += 1)),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) => {
          stateBatches += 1;
          return Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' })));
        },
      },
    })
      .resolveModuleTarget(context, { canonicalPath: '/contacts/customers/customer-123' })
      .pipe(Effect.flip);
    expect(failure).toBeInstanceOf(ShellCompositionUnavailableError);
    expect({ permissionBatches, stateBatches }).toEqual({ permissionBatches: 0, stateBatches: 0 });
  }),
);

it.effect('defensively denies an ambiguous injected catalog projection before lifecycle or permission checks', () =>
  Effect.gen(function* refusesCorruptedCatalogProjection() {
    const approvedCatalog = yield* catalogWithContactPages([
      { expose: './PageCustomerDetail', key: 'customer-detail', routePath: '/contacts/customers/:customerId' },
      { expose: './PageCustomerAlias', key: 'customer-alias', routePath: '/contacts/customer-alias/:recordId' },
    ]);
    const corruptedProjection = {
      ...approvedCatalog,
      contracts: approvedCatalog.contracts.map((contract) => ({
        ...contract,
        manifest: {
          ...contract.manifest,
          publicSurface: {
            ...contract.manifest.publicSurface,
            shellContributions: {
              ...contract.manifest.publicSurface.shellContributions,
              pages: contract.manifest.publicSurface.shellContributions.pages.map((page) =>
                page.componentKey === 'party.registry.page-customer-alias'
                  ? { ...page, routePath: '/contacts/customers/:recordId' }
                  : page,
              ),
            },
          },
        },
      })),
    };
    let permissionBatches = 0;
    let stateBatches = 0;
    const result = yield* makeShellComposition({
      catalog: Effect.succeed(corruptedProjection),
      contextAccess: contextAccess({ 'party.registry': 'allowed' }, () => (permissionBatches += 1)),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) => {
          stateBatches += 1;
          return Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' })));
        },
      },
    }).resolveModuleTarget(context, { canonicalPath: '/contacts/customers/customer-123' });
    expect(result).toEqual({ outcome: 'not_found' });
    expect({ permissionBatches, stateBatches }).toEqual({ permissionBatches: 0, stateBatches: 0 });
  }),
);

it.effect('requires reload before checking permissions when the browser selected a replaced release', () =>
  Effect.gen(function* refusesStaleBrowserRevision() {
    let permissionBatches = 0;
    let stateBatches = 0;
    const composition = makeShellComposition({
      catalog: catalog(),
      contextAccess: contextAccess({ 'property.registry': 'allowed' }, () => (permissionBatches += 1)),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) => {
          stateBatches += 1;
          return Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' })));
        },
      },
    });
    const result = yield* composition.resolveModuleTarget(context, {
      canonicalPath: '/property-registry',
      compositionRevision: 'f'.repeat(64),
    });
    expect(result).toEqual({ outcome: 'reload_required' });
    expect({ permissionBatches, stateBatches }).toEqual({ permissionBatches: 0, stateBatches: 0 });
  }),
);

it.effect.each([
  { encoded: 'customer%20name', parameter: 'customer name' },
  { encoded: '%C5%BElut%C3%BD', parameter: 'žlutý' },
  { encoded: 'customer%40example.test', parameter: 'customer@example.test' },
])('decodes safe canonical parameters once for %s', ({ encoded, parameter }) =>
  Effect.gen(function* resolvesEncodedCanonicalParameter() {
    const result = yield* makeShellComposition({
      catalog: catalogWithSecondPropertyPage('/property-registry/customers/:customerId'),
      contextAccess: contextAccess({ 'property.registry': 'allowed' }),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' }))),
      },
    }).resolveModuleTarget(context, { canonicalPath: `/property-registry/customers/${encoded}` });
    expect(result).toMatchObject({ outcome: 'resolved', routeParameters: { customerId: parameter } });
  }),
);

it.effect('rechecks access for the same pinned release after revocation', () =>
  Effect.gen(function* refusesRevokedCanonicalAccess() {
    const approvedCatalog = yield* catalog();
    let decision: ContextAccessDecision = 'allowed';
    const composition = makeShellComposition({
      catalog: Effect.succeed(approvedCatalog),
      contextAccess: {
        modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision, key }))),
      },
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' }))),
      },
    });
    const input = { canonicalPath: '/property-registry', compositionRevision: approvedCatalog.composition.revision };
    expect((yield* composition.resolveModuleTarget(context, input)).outcome).toBe('resolved');
    decision = 'denied';
    expect(yield* composition.resolveModuleTarget(context, input)).toEqual({ outcome: 'forbidden' });
  }),
);

it.effect.each([
  'property-registry',
  '//property-registry',
  '/property-registry/',
  '/property-registry?audience=attacker',
  '/property-registry#other',
  '/property-registry/../customers',
  '/property-registry/%2Fcustomers',
  '/property-registry/%2e%2e',
  '/property-registry/%00',
  '/property-registry/%',
  String.raw`/property-registry\customers`,
  '/api/private',
  '/modules/property.registry',
  '/settings',
  '/login',
  '/%6cogin',
  '/login/customer',
  '/auth/gateway-context',
  '/module-api/party-registry',
])('rejects unsafe or Shell-owned canonical selector %s', (canonicalPath) =>
  Effect.gen(function* refusesUnsafeCanonicalSelector() {
    let permissionBatches = 0;
    const result = yield* makeShellComposition({
      catalog: catalog(),
      contextAccess: contextAccess({ 'property.registry': 'allowed' }, () => (permissionBatches += 1)),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' }))),
      },
    }).resolveModuleTarget(context, { canonicalPath });
    expect(result).toEqual({ outcome: 'not_found' });
    expect(permissionBatches).toBe(0);
  }),
);

it.effect.each(['active', 'read_only', 'deprecated'] as const)(
  'resolves the exact page entrypoint in the %s lifecycle without changing module landing',
  (state) =>
    Effect.gen(function* active() {
      const composition = makeShellComposition({
        catalog: catalogWithSecondPropertyPage(),
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
