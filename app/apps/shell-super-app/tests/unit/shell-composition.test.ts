import { ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY, ONTOS_SHELL_CONTRIBUTION_ABI } from '@app/core-runtime';
import type { AccessDeclarationInput, ApplicationComposition, TenantModuleState } from '@app/core-runtime';
import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { contentDigest, makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import {
  InstalledModuleCatalogUnavailableError,
  makeInstalledModuleCatalogLoader,
} from '../../api/modules/installed-module-catalog.ts';
import { makeShellComposition, ShellCompositionUnavailableError } from '../../api/modules/shell-composition.ts';
import { ShellCompositionSchema } from '../../shared/browser-api.ts';
import { makeShellTestAccessGate, shellTestAnswers, shellTestScope } from '../support/access-decision-double.ts';
import type { ShellTestAccess } from '../support/access-decision-double.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';

const pageAccessDeclaration = (moduleId: string): AccessDeclarationInput => ({
  key: `${moduleId}.page.open`,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'pages', level: 'basic' },
  risk: 'routine',
  selectors: [],
});

const pageEntrypoint = (moduleId: string) => ({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: `${moduleId}.page.home`,
  moduleKey: moduleId,
  role: 'page',
  scope: 'tenant',
});

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
            accessDeclaration: pageAccessDeclaration(moduleId),
            contributionKey: `${moduleId}.navigation.home`,
            entrypoint: pageEntrypoint(moduleId),
            groupKey: 'shell.navigation.modules',
            order,
            pageKey: `${moduleId}.page.home`,
          },
        ],
        pages: [
          {
            accessDeclaration: pageAccessDeclaration(moduleId),
            componentKey: `${moduleId}.page-home`,
            contributionKey: `${moduleId}.page.home`,
            entrypoint: pageEntrypoint(moduleId),
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
    accessDeclaration: pageAccessDeclaration('property.registry'),
    componentKey: 'property.registry.page-customers',
    contributionKey: 'property.registry.page.customers',
    entrypoint: {
      ...pageEntrypoint('property.registry'),
      entrypointKey: 'property.registry.page.customers',
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
      accessDeclaration: pageAccessDeclaration('party.registry'),
      componentKey,
      contributionKey,
      entrypoint: {
        access: 'read',
        authorization: { kind: 'protected' },
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

const EVERY_MODULE_ALLOWED = {
  'documents.center.page.open': 'allowed',
  'party.registry.page.open': 'allowed',
  'property.registry.page.open': 'allowed',
} satisfies Record<string, ShellTestAccess>;

const scope = shellTestScope({ legalEntityId, principalId, tenantId });
const tenantScope = shellTestScope({ principalId, tenantId });

const statesOf = (state: TenantModuleState | Readonly<Record<string, TenantModuleState>>, onBatch?: () => void) => ({
  getTenantModuleStates: (_tenantId: string, moduleIds: readonly string[]) => {
    onBatch?.();
    return Effect.succeed(
      moduleIds.map((moduleKey) => ({
        moduleKey,
        state: Predicate.isString(state) ? state : (state[moduleKey] ?? 'active'),
      })),
    );
  },
});

it.effect('composes one deterministic state batch and one batched permission decision per page', () =>
  Effect.gen(function* composesOneDeterministicStateAndPermission() {
    let stateBatches = 0;
    const approvedCatalog = yield* catalog();
    const gate = makeShellTestAccessGate({ answers: EVERY_MODULE_ALLOWED });
    const composition = makeShellComposition({
      access: gate,
      catalog: Effect.succeed(approvedCatalog),
      moduleStates: statesOf('active', () => (stateBatches += 1)),
    });
    const result = yield* composition.compose(scope);
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
          state: 'active',
          unavailable: false,
          writable: true,
        },
        {
          appId: 'property-registry',
          enabled: true,
          groupKey: 'shell.navigation.modules',
          href: '/property-registry',
          label: 'Property',
          moduleId: 'property.registry',
          order: 20,
          state: 'active',
          unavailable: false,
          writable: true,
        },
      ],
      state: 'available',
      unavailableDeployments: [],
    });
    // E-BATCH: two navigation items, exactly ONE engine snapshot and no single-question call.
    expect({ batches: gate.batches.length, singles: gate.singleDecisions.length, stateBatches }).toEqual({
      batches: 1,
      singles: 0,
      stateBatches: 1,
    });
    expect(gate.batches[0]?.map(({ carrier }) => carrier.accessDeclaration?.key)).toEqual([
      'documents.center.page.open',
      'property.registry.page.open',
    ]);
  }),
);

it.effect('asks each navigation item in the page scope with no invented record target', () =>
  Effect.gen(function* asksEachNavigationItemInThePageScope() {
    const gate = makeShellTestAccessGate({ answers: EVERY_MODULE_ALLOWED });
    yield* makeShellComposition({
      access: gate,
      catalog: catalog(),
      moduleStates: statesOf('active'),
    }).compose(scope);
    expect(
      gate.batches[0]?.map(({ carrier, legalEntityScope, now, scope: asked }) => ({
        accessDeclaration: carrier.accessDeclaration,
        hasClockTime: Schema.is(Schema.Date)(now),
        hasTarget: Object.hasOwn({ carrier }, 'target'),
        legalEntityScope,
        scope: asked,
      })),
    ).toEqual([
      {
        accessDeclaration: pageAccessDeclaration('documents.center'),
        hasClockTime: true,
        hasTarget: false,
        legalEntityScope: 'required',
        scope,
      },
      {
        accessDeclaration: pageAccessDeclaration('property.registry'),
        hasClockTime: true,
        hasTarget: false,
        legalEntityScope: 'required',
        scope,
      },
    ]);
  }),
);

it.effect('fails closed before permissions or lifecycle state when complete approved authority is unavailable', () =>
  Effect.gen(function* refusesIncompleteAuthority() {
    let stateBatches = 0;
    const gate = makeShellTestAccessGate({ answers: EVERY_MODULE_ALLOWED });
    const failure = yield* makeShellComposition({
      access: gate,
      catalog: Effect.fail(new InstalledModuleCatalogUnavailableError({ reason: 'approved snapshot unavailable' })),
      moduleStates: statesOf('active', () => (stateBatches += 1)),
    })
      .compose(scope)
      .pipe(Effect.flip);
    expect(failure).toBeInstanceOf(ShellCompositionUnavailableError);
    expect({ batches: gate.batches.length, stateBatches }).toEqual({ batches: 0, stateBatches: 0 });
  }),
);

it.effect('normalizes number-like module order before returning the public composition', () =>
  Effect.gen(function* normalizesNumberLikeModuleOrderBefore() {
    const result = yield* makeShellComposition({
      access: makeShellTestAccessGate({ answers: EVERY_MODULE_ALLOWED }),
      catalog: catalogWithNumberLikeOrder(),
      moduleStates: statesOf('active'),
    }).compose(scope);

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
      const gate = makeShellTestAccessGate({ answers: EVERY_MODULE_ALLOWED });
      const result = yield* makeShellComposition({
        access: gate,
        catalog: Effect.succeed(approvedCatalog),
        moduleStates: statesOf(state),
      }).compose(scope);
      expect(result).toEqual({
        compositionRevision: approvedCatalog.composition.revision,
        navigation: [],
        state: 'available',
        unavailableDeployments: [],
      });
      // A module whose lifecycle hides it is never put to the gate at all.
      expect(gate.decisions).toEqual([]);
    }),
);

it.effect('omits definite denial while preserving unavailable authorization as disabled', () =>
  Effect.gen(function* omitsDefiniteDenialWhilePreservingUnavailable() {
    const result = yield* makeShellComposition({
      access: makeShellTestAccessGate({
        answers: {
          'documents.center.page.open': 'denied',
          'property.registry.page.open': 'unavailable',
        },
      }),
      catalog: catalog(),
      moduleStates: statesOf('active'),
    }).compose(scope);
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

it.effect('shows a navigation item that may be proposed without enabling it yet', () =>
  Effect.gen(function* showsANavigationItemThatMayBeProposed() {
    const result = yield* makeShellComposition({
      access: makeShellTestAccessGate({
        answers: {
          'documents.center.page.open': 'needs_approval',
          'property.registry.page.open': 'denied',
        },
      }),
      catalog: catalog(),
      moduleStates: statesOf('active'),
    }).compose(scope);
    expect(result.navigation).toEqual([
      {
        appId: 'documents-center',
        enabled: false,
        groupKey: 'shell.navigation.modules',
        label: 'Documents',
        moduleId: 'documents.center',
        order: 10,
        state: 'active',
        unavailable: false,
        writable: true,
      },
    ]);
  }),
);

it.effect('asks for a company when nothing company-scoped could be decided without one', () =>
  Effect.gen(function* asksForACompany() {
    const gate = makeShellTestAccessGate({ answers: {}, defaultAnswer: 'selection_required' });
    const result = yield* makeShellComposition({
      access: gate,
      catalog: catalog(),
      moduleStates: statesOf('active'),
    }).compose(tenantScope);
    expect(result).toEqual({ navigation: [], state: 'selection_required' });
    // The Shell never guesses at the company's absence: the gate reports the missing scope (O28).
    expect(gate.batches.length).toBe(1);
    expect(gate.batches[0]?.every((entry) => entry.legalEntityScope === 'required') ?? false).toBe(true);
  }),
);

it.effect('resolves direct targets independently with exhaustive safe outcomes and historical reads', () =>
  Effect.gen(function* resolvesDirectTargetsIndependentlyWithExhaustive() {
    let state: TenantModuleState = 'active';
    const answers = shellTestAnswers({ 'property.registry.page.open': 'allowed' });
    const gate = makeShellTestAccessGate({ answers });
    const composition = makeShellComposition({
      access: gate,
      catalog: catalog(),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state }))),
      },
    });
    const resolved = yield* composition.resolveModuleTarget(scope, {
      moduleId: 'property.registry',
    });
    expect(resolved.outcome).toBe('resolved');
    answers['property.registry.page.open'] = 'denied';
    const forbidden = yield* composition.resolveModuleTarget(scope, {
      moduleId: 'property.registry',
    });
    expect(forbidden.outcome).toBe('forbidden');
    expect(forbidden).not.toHaveProperty('federation');
    expect(forbidden).not.toHaveProperty('page');
    answers['property.registry.page.open'] = 'unavailable';
    const unavailable = yield* composition.resolveModuleTarget(scope, {
      moduleId: 'property.registry',
    });
    expect(unavailable.outcome).toBe('unavailable');
    answers['property.registry.page.open'] = 'allowed';
    state = 'archived';
    const archived = yield* composition.resolveModuleTarget(scope, {
      moduleId: 'property.registry',
    });
    expect(archived.outcome).toBe('not_found');
    const historical = yield* composition.resolveModuleTarget(scope, {
      access: 'historical_read',
      moduleId: 'property.registry',
    });
    expect(historical.outcome).toBe('resolved');
    answers['property.registry.page.open'] = 'selection_required';
    state = 'active';
    const selectionRequired = yield* composition.resolveModuleTarget(tenantScope, {
      moduleId: 'property.registry',
    });
    expect(selectionRequired.outcome).toBe('selection_required');
    const missing = yield* composition.resolveModuleTarget(scope, {
      moduleId: 'missing.module',
    });
    expect(missing.outcome).toBe('forbidden');
  }),
);

it.effect('denies unadmitted direct modules and preserves missing page and canonical route outcomes', () =>
  Effect.gen(function* deniesUnadmittedDirectModules() {
    let stateCalls = 0;
    const approvedCatalog = yield* catalog();
    const gate = makeShellTestAccessGate({ answers: { 'missing.module.page.open': 'allowed' } });
    const composition = makeShellComposition({
      access: gate,
      catalog: Effect.succeed(approvedCatalog),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) => {
          stateCalls += 1;
          return Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' })));
        },
      },
    });
    expect(
      yield* composition.resolveModuleTarget(scope, {
        compositionRevision: approvedCatalog.composition.revision,
        moduleId: 'missing.module',
      }),
    ).toEqual({ outcome: 'forbidden' });
    expect(
      yield* composition.resolveModuleTarget(scope, {
        entrypointKey: 'property.registry.page.missing',
        moduleId: 'property.registry',
      }),
    ).toEqual({ outcome: 'not_found' });
    expect(yield* composition.resolveModuleTarget(scope, { canonicalPath: '/missing-module' })).toEqual({
      outcome: 'not_found',
    });
    expect(stateCalls).toBe(0);
    expect(gate.decisions).toEqual([]);
  }),
);

it.effect('returns the approved release and safe named parameters for canonical routes', () =>
  Effect.gen(function* resolvesPinnedCanonicalPage() {
    const approvedCatalog = yield* catalogWithSecondPropertyPage('/property-registry/customers/:customerId');
    const composition = makeShellComposition({
      access: makeShellTestAccessGate({ answers: EVERY_MODULE_ALLOWED }),
      catalog: Effect.succeed(approvedCatalog),
      moduleStates: statesOf('active'),
    });
    const resolved = yield* composition.resolveModuleTarget(scope, {
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
      access: makeShellTestAccessGate({ answers: EVERY_MODULE_ALLOWED }),
      catalog: Effect.succeed(approvedCatalog),
      moduleStates: statesOf('active'),
    }).resolveModuleTarget(scope, { canonicalPath, compositionRevision: approvedCatalog.composition.revision });
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
      access: makeShellTestAccessGate({ answers: EVERY_MODULE_ALLOWED }),
      catalog: catalogWithContactPages(reverse ? pages.toReversed() : pages),
      moduleStates: statesOf('active'),
    }).resolveModuleTarget(scope, { canonicalPath: '/contacts/customers/create/edit' });
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
    let stateBatches = 0;
    const gate = makeShellTestAccessGate({ answers: EVERY_MODULE_ALLOWED });
    const ambiguousCatalog = catalogWithContactPages([
      { expose: './PageCustomerDetail', key: 'customer-detail', routePath: '/contacts/customers/:customerId' },
      { expose: './PageCustomerAlias', key: 'customer-alias', routePath: '/contacts/customers/:recordId' },
    ]);
    const failure = yield* makeShellComposition({
      access: gate,
      catalog: ambiguousCatalog,
      moduleStates: statesOf('active', () => (stateBatches += 1)),
    })
      .resolveModuleTarget(scope, { canonicalPath: '/contacts/customers/customer-123' })
      .pipe(Effect.flip);
    expect(failure).toBeInstanceOf(ShellCompositionUnavailableError);
    expect({ batches: gate.decisions.length, stateBatches }).toEqual({ batches: 0, stateBatches: 0 });
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
    let stateBatches = 0;
    const gate = makeShellTestAccessGate({ answers: EVERY_MODULE_ALLOWED });
    const result = yield* makeShellComposition({
      access: gate,
      catalog: Effect.succeed(corruptedProjection),
      moduleStates: statesOf('active', () => (stateBatches += 1)),
    }).resolveModuleTarget(scope, { canonicalPath: '/contacts/customers/customer-123' });
    expect(result).toEqual({ outcome: 'not_found' });
    expect({ batches: gate.decisions.length, stateBatches }).toEqual({ batches: 0, stateBatches: 0 });
  }),
);

it.effect('requires reload before checking permissions when the browser selected a replaced release', () =>
  Effect.gen(function* refusesStaleBrowserRevision() {
    let stateBatches = 0;
    const gate = makeShellTestAccessGate({ answers: EVERY_MODULE_ALLOWED });
    const composition = makeShellComposition({
      access: gate,
      catalog: catalog(),
      moduleStates: statesOf('active', () => (stateBatches += 1)),
    });
    const result = yield* composition.resolveModuleTarget(scope, {
      canonicalPath: '/property-registry',
      compositionRevision: 'f'.repeat(64),
    });
    expect(result).toEqual({ outcome: 'reload_required' });
    expect({ batches: gate.decisions.length, stateBatches }).toEqual({ batches: 0, stateBatches: 0 });
  }),
);

it.effect.each([
  { encoded: 'customer%20name', parameter: 'customer name' },
  { encoded: '%C5%BElut%C3%BD', parameter: 'žlutý' },
  { encoded: 'customer%40example.test', parameter: 'customer@example.test' },
])('decodes safe canonical parameters once for %s', ({ encoded, parameter }) =>
  Effect.gen(function* resolvesEncodedCanonicalParameter() {
    const result = yield* makeShellComposition({
      access: makeShellTestAccessGate({ answers: EVERY_MODULE_ALLOWED }),
      catalog: catalogWithSecondPropertyPage('/property-registry/customers/:customerId'),
      moduleStates: statesOf('active'),
    }).resolveModuleTarget(scope, { canonicalPath: `/property-registry/customers/${encoded}` });
    expect(result).toMatchObject({ outcome: 'resolved', routeParameters: { customerId: parameter } });
  }),
);

it.effect('rechecks access for the same pinned release after revocation', () =>
  Effect.gen(function* refusesRevokedCanonicalAccess() {
    const approvedCatalog = yield* catalog();
    const answers = shellTestAnswers({ 'property.registry.page.open': 'allowed' });
    const composition = makeShellComposition({
      access: makeShellTestAccessGate({ answers }),
      catalog: Effect.succeed(approvedCatalog),
      moduleStates: statesOf('active'),
    });
    const input = { canonicalPath: '/property-registry', compositionRevision: approvedCatalog.composition.revision };
    expect((yield* composition.resolveModuleTarget(scope, input)).outcome).toBe('resolved');
    answers['property.registry.page.open'] = 'denied';
    expect(yield* composition.resolveModuleTarget(scope, input)).toEqual({ outcome: 'forbidden' });
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
    const gate = makeShellTestAccessGate({ answers: EVERY_MODULE_ALLOWED });
    const result = yield* makeShellComposition({
      access: gate,
      catalog: catalog(),
      moduleStates: statesOf('active'),
    }).resolveModuleTarget(scope, { canonicalPath });
    expect(result).toEqual({ outcome: 'not_found' });
    expect(gate.decisions).toEqual([]);
  }),
);

it.effect.each(['active', 'read_only', 'deprecated'] as const)(
  'resolves the exact page entrypoint in the %s lifecycle without changing module landing',
  (state) =>
    Effect.gen(function* active() {
      const composition = makeShellComposition({
        access: makeShellTestAccessGate({ answers: EVERY_MODULE_ALLOWED }),
        catalog: catalogWithSecondPropertyPage(),
        moduleStates: statesOf(state),
      });
      const landing = yield* composition.resolveModuleTarget(scope, {
        moduleId: 'property.registry',
      });
      const customers = yield* composition.resolveModuleTarget(scope, {
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
      const missingPage = yield* composition.resolveModuleTarget(scope, {
        entrypointKey: 'property.registry.page.missing',
        moduleId: 'property.registry',
      });
      expect(missingPage.outcome).toBe('not_found');
      const crossOwnedPage = yield* composition.resolveModuleTarget(scope, {
        entrypointKey: 'documents.center.page.home',
        moduleId: 'property.registry',
      });
      expect(crossOwnedPage.outcome).toBe('not_found');
    }),
);

it.effect('decides an access-administration page in the tenant context without a selected company', () =>
  Effect.gen(function* decidesAdminPageInTenantContext() {
    const admin = deployment('access-admin', 'core.shell', 'Access', 5);
    admin.manifest.publicSurface.shellContributions.navigation = [];
    admin.manifest.publicSurface.shellContributions.pages = [
      {
        accessDeclaration: {
          key: 'core.shell.roles.page.open',
          kind: 'admin',
          modes: ['run'],
          placement: { group: 'access', level: 'manage' },
          risk: 'critical',
          selectors: [],
        },
        componentKey: 'core.shell.page-home',
        contributionKey: 'core.shell.page.roles',
        entrypoint: pageEntrypoint('core.shell'),
        expose: './PageHome',
        routePath: '/access/roles',
      },
    ];
    const approvedCatalog = yield* makeInstalledModuleCatalogLoader(makeCompositionSnapshot([admin]));
    const gate = makeShellTestAccessGate({ answers: { 'core.shell.roles.page.open': 'allowed' } });
    const resolved = yield* makeShellComposition({
      access: gate,
      catalog: Effect.succeed(approvedCatalog),
      moduleStates: statesOf('active'),
    }).resolveModuleTarget(tenantScope, { canonicalPath: '/access/roles' });
    expect(resolved).toMatchObject({ moduleId: 'core.shell', outcome: 'resolved' });
    // O28: administration never depends on a company selection, so the question is asked in the
    // tenant context; every business page above it is asked in the company context instead.
    expect(gate.singleDecisions[0]?.legalEntityScope).toBe('optional');
  }),
);

it.effect('pins published fixture bytes to its receiver and rejects a different receiver', () =>
  Effect.gen(function* verifyPublishedFixtureReceiver() {
    const receiverDeployment: ApplicationComposition['shell']['deployment'] = {
      appId: 'shell-super-app',
      buildMarker: 'compiled-fixture-shell-release',
    };
    const document = JSON.stringify(
      {
        contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
        coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
        deployment: receiverDeployment,
        schemaVersion: '2',
      },
      null,
      2,
    );
    const snapshot = yield* makeCompositionSnapshot([], 60_000, { document, receiverDeployment });
    expect(snapshot.composition.shell.deployment).toEqual(receiverDeployment);
    expect(snapshot.composition.shell.coreCapabilities).toEqual([ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY]);
    expect(snapshot.composition.shell.runtimeContract.sha256).toBe(contentDigest(document));
    expect(snapshot.composition.shell.runtimeContract.url).toContain('/releases/compiled-fixture-shell-release/');
    const mismatch = yield* makeCompositionSnapshot([], 60_000, {
      document,
      receiverDeployment: { appId: 'shell-super-app', buildMarker: 'different-compiled-fixture-shell-release' },
    }).pipe(Effect.flip);
    expect(mismatch.reason).toBe('The actual Shell runtime document must match the compiled fixture receiver');
  }),
);
