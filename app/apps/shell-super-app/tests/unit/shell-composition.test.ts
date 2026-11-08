import type {
  AccessDeclarationInput,
  ApplicationComposition,
  ContextAccessDecision,
  TenantModuleState,
} from '@app/core-runtime';
import { ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY, ONTOS_SHELL_CONTRIBUTION_ABI } from '@app/core-runtime';
import { LegalEntityNavigationExclusionsUnavailableError } from '@app/core-runtime/modules/legal-entity-navigation-exclusions';
import { Cause, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { contentDigest, makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import {
  InstalledModuleCatalogUnavailableError,
  makeInstalledModuleCatalogLoader,
} from '../../api/modules/installed-module-catalog.ts';
import {
  makeShellCompositionAccess,
  makeShellCompositionData,
  ShellCompositionUnavailableError,
} from '../../api/modules/shell-composition.ts';
import type {
  ShellCompositionAccessSources,
  ShellCompositionContext,
  ShellCompositionDataSources,
} from '../../api/modules/shell-composition.ts';
import { ShellCompositionSchema } from '../../shared/api.ts';
import { moduleTargetLogAnnotations } from '../../api/modules/module-target-log.ts';
import { makeShellTestAccessGate, shellTestScope } from '../support/access-decision-double.ts';
import type { GateInput } from '@app/core-runtime/access/enforcement';
import type { ShellTestAccess, ShellTestAccessGate } from '../support/access-decision-double.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';

interface PageGateAnswers extends Record<string, ShellTestAccess> {
  'property.registry.page.open': ShellTestAccess;
}

/** The module's landing page contribution, optionally opted into tenant-only admission. */
/**
 * One page capability as the access gate asks it. A page the fixture opts into tenant-only admission is
 * declared `admin` (the one v2 scope the Shell can state without a selected company); every other page is
 * company-owned business data.
 */
const pageAccessDeclaration = (moduleId: string, legalEntityScope?: 'optional'): AccessDeclarationInput => ({
  key: `${moduleId}.page.open`,
  kind: legalEntityScope === 'optional' ? 'admin' : 'read',
  modes: ['run'],
  placement: { group: 'pages', level: 'basic' },
  risk: legalEntityScope === 'optional' ? 'sensitive' : 'routine',
  selectors: [],
});

const pageHomeContribution = (appId: string, moduleId: string, legalEntityScope?: 'optional') => ({
  accessDeclaration: pageAccessDeclaration(moduleId, legalEntityScope),
  componentKey: `${moduleId}.page-home`,
  contributionKey: `${moduleId}.page.home`,
  entrypoint: {
    access: 'read',
    authorization: { kind: 'protected' as const },
    entrypointKey: `${moduleId}.page.home`,
    moduleKey: moduleId,
    role: 'page',
    scope: 'tenant' as const,
  },
  expose: './PageHome',
  routePath: `/${appId}`,
});

const deployment = (
  appId: string,
  moduleId: string,
  displayName: string,
  order: number,
  legalEntityScope?: 'optional',
) => ({
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
            accessDeclaration: pageAccessDeclaration(moduleId, legalEntityScope),
            contributionKey: `${moduleId}.navigation.home`,
            entrypoint: {
              access: 'read',
              authorization: { kind: 'protected' },
              entrypointKey: `${moduleId}.page.home`,
              moduleKey: moduleId,
              role: 'page',
              scope: 'tenant',
            },
            groupKey: 'shell.navigation.modules',
            icon: 'icon-[mdi--view-grid-outline]',
            label: { cs: displayName, en: displayName },
            order,
            pageKey: `${moduleId}.page.home`,
          },
        ],
        pages: [pageHomeContribution(appId, moduleId, legalEntityScope)],
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
      access: 'read',
      authorization: { kind: 'protected' },
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

it.effect(
  'module-target diagnostics identify the approved target and caller without logging resource IDs or secrets',
  () =>
    Effect.gen(function* boundedTargetDiagnostics() {
      const approvedCatalog = yield* catalogWithContactPages([
        { expose: './CustomerDetail', key: 'customer-detail', routePath: '/contacts/customers/:customerId' },
      ]);
      const annotations = moduleTargetLogAnnotations(approvedCatalog, {
        reportedSource: 'menu_prefetch',
        selector: { canonicalPath: '/contacts/customers/private-customer' },
        sourcePath: '/cs/contacts/customers/private-customer?token=never-log-this',
      });
      expect(annotations).toEqual({
        targetAppKey: 'party-registry',
        targetKey: 'party.registry.page.customer-detail',
        targetKind: 'canonical_path',
        targetModuleKey: 'party.registry',
        targetRoute: '/contacts/customers/:customerId',
        targetSource: 'menu_prefetch',
        targetSourceModule: 'party.registry',
        targetSourceRoute: '/contacts/customers/:customerId',
      });
      expect(JSON.stringify(annotations)).not.toContain('private-customer');
      expect(JSON.stringify(annotations)).not.toContain('never-log-this');
      const unknown = moduleTargetLogAnnotations(approvedCatalog, {
        reportedSource: 'never-log-this',
        selector: { entrypointKey: 'never-log-this', moduleId: 'never-log-this' },
        sourcePath: '//never-log-this.example/secret',
      });
      expect(unknown).toEqual({
        targetAppKey: 'unknown',
        targetKey: 'unknown',
        targetKind: 'entrypoint',
        targetModuleKey: 'unknown',
        targetRoute: 'unknown',
        targetSource: 'unknown',
        targetSourceModule: 'unknown',
        targetSourceRoute: 'unknown',
      });
      expect(JSON.stringify(unknown)).not.toContain('never-log-this');
      expect(
        moduleTargetLogAnnotations(approvedCatalog, {
          selector: { entrypointKey: 'removed-entrypoint', moduleId: 'party.registry' },
        }),
      ).toMatchObject({ targetAppKey: 'party-registry', targetKey: 'unknown', targetModuleKey: 'party.registry' });
    }),
);

/**
 * The one access gate a Shell suite scripts, keyed by module id for readability. The fixture's pages ask
 * `${moduleId}.page.open`, so the shim maps that declaration key and reports the module ids one gate
 * snapshot covered (E-BATCH), never a per-module permission call.
 */
const moduleIdsOf = (inputs: readonly GateInput[]) =>
  inputs.flatMap(({ carrier }) => {
    const key = carrier.accessDeclaration?.key;
    return key === undefined ? [] : [key.replace(/\.page\.open$/u, '')];
  });

const contextAccess = (
  decisions: Readonly<Record<string, ContextAccessDecision>>,
  onBatch?: (moduleIds: readonly string[]) => void,
): ShellTestAccessGate => {
  const answers = Object.fromEntries(
    Object.entries(decisions).map(([moduleId, decision]) => [`${moduleId}.page.open`, decision]),
  );
  const gate = makeShellTestAccessGate({ answers });
  return {
    ...gate,
    decide: (input) => {
      onBatch?.(moduleIdsOf([input]));
      return gate.decide(input);
    },
    decideMany: (input) => {
      onBatch?.(moduleIdsOf(input));
      return gate.decideMany(input);
    },
  };
};

const context = shellTestScope({ legalEntityId, principalId, tenantId });

/** Runs the composition steps in the governed-read order: access before, tenant data inside, finish after. */
const makeShellComposition = (sources: {
  readonly catalog: ShellCompositionAccessSources['catalog'];
  readonly contextAccess: ShellTestAccessGate;
  readonly moduleStates: ShellCompositionDataSources['moduleStates'];
  readonly navigationExclusions: ShellCompositionDataSources['navigationExclusions'];
}) => {
  const access = makeShellCompositionAccess({ access: sources.contextAccess, catalog: sources.catalog });
  const data = makeShellCompositionData({
    moduleStates: sources.moduleStates,
    navigationExclusions: sources.navigationExclusions,
  });
  return {
    compose: (composeContext: ShellCompositionContext) =>
      access
        .authorizeComposition(composeContext)
        .pipe(
          Effect.flatMap((authorization) =>
            data
              .loadComposition(composeContext, authorization)
              .pipe(Effect.flatMap((loaded) => access.finishComposition(authorization, loaded))),
          ),
        ),
    resolveModuleTarget: (
      targetContext: ShellCompositionContext,
      input: Parameters<typeof access.authorizeModuleTarget>[1],
    ) =>
      access
        .authorizeModuleTarget(targetContext, input)
        .pipe(
          Effect.flatMap((authorization) =>
            data
              .loadModuleTarget(targetContext, authorization)
              .pipe(Effect.map((state) => access.finishModuleTarget(authorization, state))),
          ),
        ),
    resolveTenantModuleTarget: (
      targetContext: ShellCompositionContext,
      input: Parameters<typeof access.authorizeTenantModuleTarget>[1],
    ) =>
      access
        .authorizeTenantModuleTarget(targetContext, input)
        .pipe(
          Effect.flatMap((authorization) =>
            data
              .loadModuleTarget(targetContext, authorization)
              .pipe(Effect.map((state) => access.finishModuleTarget(authorization, state))),
          ),
        ),
  };
};

/** Company navigation settings with nothing excluded. */
const noExclusions = { listExcludedEntrypoints: () => Effect.succeed(new Set<string>()) };

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
      navigationExclusions: noExclusions,
    });
    const result = yield* composition.compose(context);
    // Each destination names its page's approved remote, so the browser can load the code while idle.
    const approvedRemote = (moduleId: string) => {
      const approved = approvedCatalog.composition.modules.find((module) => module.moduleId === moduleId);
      return approved?.federation.execution === 'browser'
        ? {
            expose: './PageHome',
            manifest: { sha256: approved.federation.manifest.sha256, url: approved.federation.manifest.url },
            remoteName: approved.federation.remoteName,
          }
        : undefined;
    };
    expect(result).toEqual({
      compositionRevision: approvedCatalog.composition.revision,
      deniedAppIds: [],
      gatewayAudiences: ['documents-center', 'property-registry'],
      homeComponents: [],
      navigation: [
        {
          appId: 'documents-center',
          enabled: true,
          entrypointKey: 'documents.center.page.home',
          groupKey: 'shell.navigation.modules',
          href: '/documents-center',
          icon: 'icon-[mdi--view-grid-outline]',
          label: { cs: 'Documents', en: 'Documents' },
          moduleId: 'documents.center',
          order: 10,
          remote: approvedRemote('documents.center'),
          state: 'read_only',
          unavailable: false,
          writable: false,
        },
        {
          appId: 'property-registry',
          enabled: true,
          entrypointKey: 'property.registry.page.home',
          groupKey: 'shell.navigation.modules',
          href: '/property-registry',
          icon: 'icon-[mdi--view-grid-outline]',
          label: { cs: 'Property', en: 'Property' },
          moduleId: 'property.registry',
          order: 20,
          remote: approvedRemote('property.registry'),
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
      navigationExclusions: noExclusions,
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
      navigationExclusions: noExclusions,
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
        navigationExclusions: noExclusions,
      }).compose(context);
      expect(result).toEqual({
        compositionRevision: approvedCatalog.composition.revision,
        deniedAppIds: [],
        gatewayAudiences: ['documents-center', 'property-registry'],
        homeComponents: [],
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
      navigationExclusions: noExclusions,
    }).compose(context);
    expect(result.state).toBe('available');
    // Only the definite denial is a browser hint; unavailable authorization is never treated as denied.
    expect(result).toHaveProperty('deniedAppIds', ['documents-center']);
    // The document obtains assertions for every deployment it may call, never for a definitely denied one.
    expect(result).toHaveProperty('gatewayAudiences', ['property-registry']);
    expect(result.navigation).toEqual([
      {
        appId: 'property-registry',
        enabled: false,
        entrypointKey: 'property.registry.page.home',
        groupKey: 'shell.navigation.modules',
        icon: 'icon-[mdi--view-grid-outline]',
        label: { cs: 'Property', en: 'Property' },
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
    const answers: PageGateAnswers = { 'property.registry.page.open': 'allowed' };
    const composition = makeShellComposition({
      catalog: catalog(),
      contextAccess: makeShellTestAccessGate({ answers }),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state }))),
      },
      navigationExclusions: noExclusions,
    });
    const resolved = yield* composition.resolveModuleTarget(context, {
      moduleId: 'property.registry',
    });
    expect(resolved.outcome).toBe('resolved');
    answers['property.registry.page.open'] = 'denied';
    const forbidden = yield* composition.resolveModuleTarget(context, {
      moduleId: 'property.registry',
    });
    expect(forbidden.outcome).toBe('forbidden');
    expect(forbidden).not.toHaveProperty('federation');
    expect(forbidden).not.toHaveProperty('page');
    answers['property.registry.page.open'] = 'unavailable';
    const unavailable = yield* composition.resolveModuleTarget(context, {
      moduleId: 'property.registry',
    });
    expect(unavailable.outcome).toBe('unavailable');
    answers['property.registry.page.open'] = 'allowed';
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
    const selectionRequired = yield* composition.resolveModuleTarget(shellTestScope({ principalId, tenantId }), {
      moduleId: 'property.registry',
    });
    expect(selectionRequired.outcome).toBe('selection_required');
    const missing = yield* composition.resolveModuleTarget(context, {
      moduleId: 'missing.module',
    });
    expect(missing.outcome).toBe('not_found');
  }),
);

it.effect('reports unknown direct modules, missing pages and canonical routes as not found', () =>
  Effect.gen(function* deniesUnadmittedDirectModules() {
    let stateCalls = 0;
    let permissionCalls = 0;
    const approvedCatalog = yield* catalog();
    const composition = makeShellComposition({
      catalog: Effect.succeed(approvedCatalog),
      contextAccess: contextAccess({ 'missing.module': 'allowed' }, () => (permissionCalls += 1)),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) => {
          stateCalls += 1;
          return Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' })));
        },
      },
      navigationExclusions: noExclusions,
    });
    expect(
      yield* composition.resolveModuleTarget(context, {
        compositionRevision: approvedCatalog.composition.revision,
        moduleId: 'missing.module',
      }),
    ).toEqual({ outcome: 'not_found' });
    expect(
      yield* composition.resolveModuleTarget(context, {
        entrypointKey: 'property.registry.page.missing',
        moduleId: 'property.registry',
      }),
    ).toEqual({ outcome: 'not_found' });
    expect(yield* composition.resolveModuleTarget(context, { canonicalPath: '/missing-module' })).toEqual({
      outcome: 'not_found',
    });
    expect(stateCalls).toBe(0);
    expect(permissionCalls).toBe(0);
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
      navigationExclusions: noExclusions,
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
      navigationExclusions: noExclusions,
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
      navigationExclusions: noExclusions,
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
      navigationExclusions: noExclusions,
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
      navigationExclusions: noExclusions,
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
      navigationExclusions: noExclusions,
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
      navigationExclusions: noExclusions,
    }).resolveModuleTarget(context, { canonicalPath: `/property-registry/customers/${encoded}` });
    expect(result).toMatchObject({ outcome: 'resolved', routeParameters: { customerId: parameter } });
  }),
);

it.effect('rechecks access for the same pinned release after revocation', () =>
  Effect.gen(function* refusesRevokedCanonicalAccess() {
    const approvedCatalog = yield* catalog();
    const answers: PageGateAnswers = { 'property.registry.page.open': 'allowed' };
    const composition = makeShellComposition({
      catalog: Effect.succeed(approvedCatalog),
      contextAccess: makeShellTestAccessGate({ answers }),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' }))),
      },
      navigationExclusions: noExclusions,
    });
    const input = { canonicalPath: '/property-registry', compositionRevision: approvedCatalog.composition.revision };
    expect((yield* composition.resolveModuleTarget(context, input)).outcome).toBe('resolved');
    answers['property.registry.page.open'] = 'denied';
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
      navigationExclusions: noExclusions,
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
        navigationExclusions: noExclusions,
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

const publicComponentCatalog = () => {
  const owner = deployment('property-registry', 'property.registry', 'Property', 20);
  return makeInstalledModuleCatalogLoader(
    makeCompositionSnapshot([
      {
        ...owner,
        manifest: {
          ...owner.manifest,
          publicSurface: {
            ...owner.manifest.publicSurface,
            components: [
              ...owner.manifest.publicSurface.components,
              { expose: './Overview', key: 'property.registry.overview', mfBoundaryId: 'verticalpropertyregistry' },
            ],
            shellContributions: {
              ...owner.manifest.publicSurface.shellContributions,
              publicComponents: [
                {
                  accessDeclaration: {
                    key: 'property.registry.component.overview.open',
                    kind: 'read',
                    modes: ['run'],
                    placement: { group: 'components', level: 'basic' },
                    risk: 'routine',
                    selectors: [],
                  },
                  componentKey: 'property.registry.overview',
                  contributionKey: 'property.registry.component.overview',
                  entrypoint: {
                    access: 'read',
                    authorization: { kind: 'protected' },
                    entrypointKey: 'property.registry.component.overview',
                    moduleKey: 'property.registry',
                    role: 'public_component',
                    scope: 'tenant',
                  },
                  expose: './Overview',
                },
              ],
            },
          },
        },
      },
    ]),
  );
};

it.effect('resolves only exact declared public components after fresh module, lifecycle and declaration gates', () =>
  Effect.gen(function* publicComponentAuthorizationGate() {
    const approvedCatalog = yield* publicComponentCatalog();
    const componentAccess = makeShellTestAccessGate({
      answers: { 'property.registry.component.overview.open': 'allowed' },
    });
    const source = {
      catalog: Effect.succeed(approvedCatalog),
      contextAccess: componentAccess,
      moduleStates: {
        getTenantModuleStates: () => Effect.succeed([{ moduleKey: 'property.registry', state: 'active' as const }]),
      },
      navigationExclusions: noExclusions,
    };
    const composition = makeShellComposition(source);
    const selector = { entrypointKey: 'property.registry.component.overview', moduleId: 'property.registry' };
    const result = yield* composition.resolveModuleTarget(context, selector);
    expect(result.outcome).toBe('resolved');
    // One gate question per protected surface: the component's own declaration, in the request's scope.
    expect(componentAccess.decisions.map(({ carrier }) => carrier.accessDeclaration?.key)).toEqual([
      'property.registry.component.overview.open',
    ]);
    expect(
      (yield* composition.resolveModuleTarget(context, {
        ...selector,
        entrypointKey: 'property.registry.component.undeclared',
      })).outcome,
    ).toBe('not_found');
    expect((yield* composition.resolveModuleTarget(context, { canonicalPath: '/Overview' })).outcome).toBe('not_found');
    expect((yield* composition.resolveModuleTarget(shellTestScope({ principalId, tenantId }), selector)).outcome).toBe(
      'selection_required',
    );
    for (const decision of ['denied', 'unavailable'] as const) {
      const gated = makeShellComposition({
        ...source,
        contextAccess: makeShellTestAccessGate({
          answers: { 'property.registry.component.overview.open': decision },
        }),
      });
      expect((yield* gated.resolveModuleTarget(context, selector)).outcome).toBe(
        decision === 'denied' ? 'forbidden' : 'unavailable',
      );
    }
    const inactive = makeShellComposition({
      ...source,
      moduleStates: {
        getTenantModuleStates: () => Effect.succeed([{ moduleKey: 'property.registry', state: 'inactive' as const }]),
      },
    });
    expect((yield* inactive.resolveModuleTarget(context, selector)).outcome).toBe('not_found');
    // Access is decided before the transaction reads the module state, so an inactive module was checked too.
    expect(componentAccess.decisions.length).toBeGreaterThanOrEqual(2);
  }),
);

/**
 * The default catalog with exactly the property home page opted into tenant-only admission. The opt-in is built into
 * the composition before decoding, so the installed catalog's own `getByModuleId` contract carries it (a post-hoc
 * mutation of `catalog.contracts` would be invisible to that closure-held lookup).
 */
const optedInCatalog = () =>
  makeInstalledModuleCatalogLoader(
    makeCompositionSnapshot([
      deployment('property-registry', 'property.registry', 'Property', 20, 'optional'),
      deployment('documents-center', 'documents.center', 'Documents', 10),
    ]),
  );

it.effect('admits an opted-in page to a tenant session only through a genuine tenant module permission', () =>
  Effect.gen(function* tenantOnlyPageAdmission() {
    const approvedCatalog = yield* optedInCatalog();
    const answers: PageGateAnswers = { 'property.registry.page.open': 'allowed' };
    const gate = makeShellTestAccessGate({ answers });
    const source = {
      catalog: Effect.succeed(approvedCatalog),
      contextAccess: gate,
      moduleStates: {
        getTenantModuleStates: () => Effect.succeed([{ moduleKey: 'property.registry', state: 'active' as const }]),
      },
      navigationExclusions: noExclusions,
    };
    const composition = makeShellComposition(source);
    const tenantContext = shellTestScope({ principalId, tenantId });
    expect(
      (yield* composition.resolveTenantModuleTarget(tenantContext, { moduleId: 'property.registry' })).outcome,
    ).toBe('resolved');
    expect(gate.decisions.map(({ carrier }) => carrier.accessDeclaration?.key)).toEqual([
      'property.registry.page.open',
    ]);
    answers['property.registry.page.open'] = 'denied';
    expect(
      (yield* composition.resolveTenantModuleTarget(tenantContext, { moduleId: 'property.registry' })).outcome,
    ).toBe('forbidden');
    answers['property.registry.page.open'] = 'unavailable';
    expect(
      (yield* composition.resolveTenantModuleTarget(tenantContext, { moduleId: 'property.registry' })).outcome,
    ).toBe('unavailable');
    // The tenant path never admits a request that already carries a selected company.
    expect((yield* composition.resolveTenantModuleTarget(context, { moduleId: 'property.registry' })).outcome).toBe(
      'selection_required',
    );
  }),
);

it.effect('keeps a page without the opt-in and every public component company-required for a tenant session', () =>
  Effect.gen(function* tenantOnlyPageRefusals() {
    const gate = makeShellTestAccessGate({
      answers: { 'property.registry.component.overview.open': 'allowed', 'property.registry.page.open': 'allowed' },
    });
    const source = {
      contextAccess: gate,
      moduleStates: {
        getTenantModuleStates: () => Effect.succeed([{ moduleKey: 'property.registry', state: 'active' as const }]),
      },
      navigationExclusions: noExclusions,
    };
    const composition = makeShellComposition({ ...source, catalog: catalog() });
    const tenantContext = shellTestScope({ principalId, tenantId });
    expect(
      (yield* composition.resolveTenantModuleTarget(tenantContext, { moduleId: 'property.registry' })).outcome,
    ).toBe('selection_required');
    expect(
      (yield* composition.resolveTenantModuleTarget(tenantContext, { canonicalPath: '/missing-module' })).outcome,
    ).toBe('not_found');
    const componentComposition = makeShellComposition({
      ...source,
      catalog: publicComponentCatalog(),
    });
    expect(
      (yield* componentComposition.resolveTenantModuleTarget(tenantContext, {
        entrypointKey: 'property.registry.component.overview',
        moduleId: 'property.registry',
      })).outcome,
    ).toBe('selection_required');
    // The canonical gate sees the required-company carriers, never a tenant-scoped substitute.
    expect(gate.decisions).toHaveLength(2);
    expect(gate.decisions.every(({ legalEntityScope }) => legalEntityScope === 'required')).toBe(true);
  }),
);

it.effect('uses the selected legal entity for navigation and direct page authorization', () =>
  Effect.gen(function* scopesCompanyModules() {
    const rentalLegalEntityId = '20000000-0000-4000-8000-000000000002';
    // The gate answers per request context: the same declaration is allowed for one company and denied for the
    // other, so the suite flips the scripted answers between the two composes exactly as the engine would.
    const answers: PageGateAnswers = {
      'documents.center.page.open': 'allowed',
      'property.registry.page.open': 'denied',
    };
    const composition = makeShellComposition({
      catalog: catalog(),
      contextAccess: makeShellTestAccessGate({ answers }),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' }))),
      },
      navigationExclusions: noExclusions,
    });
    const rentalContext = { ...context, legalEntityId: rentalLegalEntityId };
    expect((yield* composition.compose(context)).navigation.map(({ moduleId }) => moduleId)).toEqual([
      'documents.center',
    ]);
    answers['documents.center.page.open'] = 'denied';
    answers['property.registry.page.open'] = 'allowed';
    expect((yield* composition.compose(rentalContext)).navigation.map(({ moduleId }) => moduleId)).toEqual([
      'property.registry',
    ]);
    const hiddenTarget = yield* composition.resolveModuleTarget(rentalContext, { canonicalPath: '/documents-center' });
    expect(hiddenTarget.outcome).toBe('forbidden');
    expect(hiddenTarget).not.toHaveProperty('federation');
    expect(hiddenTarget).not.toHaveProperty('page');
    answers['documents.center.page.open'] = 'allowed';
    expect((yield* composition.resolveModuleTarget(context, { canonicalPath: '/documents-center' })).outcome).toBe(
      'resolved',
    );
  }),
);

it.effect('drops destinations the selected company excludes and keeps the others', () =>
  Effect.gen(function* dropsExcludedDestinations() {
    const asked: (readonly [string, string])[] = [];
    const composition = makeShellComposition({
      catalog: catalog(),
      contextAccess: contextAccess({ 'documents.center': 'allowed', 'property.registry': 'allowed' }),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' }))),
      },
      navigationExclusions: {
        listExcludedEntrypoints: (selectedTenantId, selectedLegalEntityId) => {
          asked.push([selectedTenantId, selectedLegalEntityId]);
          return Effect.succeed(new Set(['documents.center.page.home']));
        },
      },
    });
    const result = yield* composition.compose(context);
    expect(result.navigation.map(({ entrypointKey }) => entrypointKey)).toEqual(['property.registry.page.home']);
    expect(asked).toEqual([[tenantId, legalEntityId]]);
    // Exclusion is navigation presentation only: the page itself still resolves for people who may open it.
    expect((yield* composition.resolveModuleTarget(context, { canonicalPath: '/documents-center' })).outcome).toBe(
      'resolved',
    );
  }),
);

it.effect('fails closed when the company navigation settings cannot be read', () =>
  Effect.gen(function* failsClosedWithoutExclusions() {
    const failure = yield* makeShellComposition({
      catalog: catalog(),
      contextAccess: contextAccess({ 'documents.center': 'allowed' }),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' }))),
      },
      navigationExclusions: {
        listExcludedEntrypoints: () =>
          Effect.fail(
            new LegalEntityNavigationExclusionsUnavailableError({
              code: 'legal_entity_navigation_exclusions_unavailable',
              reason: 'unavailable in test',
            }),
          ),
      },
    })
      .compose(context)
      .pipe(Effect.flip);
    expect(failure).toBeInstanceOf(ShellCompositionUnavailableError);
  }),
);

it.effect('keeps the admitted Shell frame available when every contributed module is denied', () =>
  Effect.gen(function* zeroRoleComposition() {
    const checkedModules: string[] = [];
    const approvedCatalog = yield* catalog();
    const sources = {
      catalog: Effect.succeed(approvedCatalog),
      contextAccess: contextAccess({}, (moduleIds) => checkedModules.push(...moduleIds)),
      moduleStates: {
        getTenantModuleStates: (_tenantId: string, moduleIds: readonly string[]) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' as const }))),
      },
      navigationExclusions: noExclusions,
    };
    yield* makeShellCompositionAccess({
      access: sources.contextAccess,
      catalog: sources.catalog,
    }).prefetchCompositionDecisions(context);
    const result = yield* makeShellComposition(sources).compose(context);
    expect(result).toEqual({
      compositionRevision: approvedCatalog.composition.revision,
      deniedAppIds: ['documents-center', 'property-registry'],
      gatewayAudiences: [],
      homeComponents: [],
      navigation: [],
      state: 'available',
      unavailableDeployments: [],
    });
    expect(new Set(checkedModules)).toEqual(new Set(approvedCatalog.moduleIds));
    expect(checkedModules).not.toContain('core.shell');
  }),
);

it.effect('shows a navigation item that may be proposed without enabling it yet', () =>
  Effect.gen(function* showsANavigationItemThatMayBeProposed() {
    const result = yield* makeShellComposition({
      catalog: catalog(),
      contextAccess: makeShellTestAccessGate({
        answers: {
          'documents.center.page.open': 'needs_approval',
          'property.registry.page.open': 'denied',
        },
      }),
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' }))),
      },
      navigationExclusions: noExclusions,
    }).compose(context);
    expect(result.navigation).toEqual([
      {
        appId: 'documents-center',
        enabled: false,
        entrypointKey: 'documents.center.page.home',
        groupKey: 'shell.navigation.modules',
        icon: 'icon-[mdi--view-grid-outline]',
        label: { cs: 'Documents', en: 'Documents' },
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
    const tenantContext = shellTestScope({ principalId, tenantId });
    const result = yield* makeShellComposition({
      catalog: catalog(),
      contextAccess: gate,
      moduleStates: {
        getTenantModuleStates: (_tenantId, moduleIds) =>
          Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' }))),
      },
      navigationExclusions: noExclusions,
    }).compose(tenantContext);
    expect(result).toEqual({ navigation: [], state: 'selection_required' });
    // The Shell never guesses at the company's absence: the gate reports the missing scope (O28).
    expect(gate.batches.length).toBe(1);
    expect(gate.batches[0]?.every((entry) => entry.legalEntityScope === 'required') ?? false).toBe(true);
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
    }).pipe(Effect.exit);
    expect(Exit.isFailure(mismatch)).toBe(true);
    if (Exit.isFailure(mismatch)) {
      expect(Cause.pretty(mismatch.cause)).toContain(
        'The actual Shell runtime document must match the compiled fixture receiver',
      );
    }
  }),
);
