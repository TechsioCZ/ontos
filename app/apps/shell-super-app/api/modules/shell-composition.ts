import type {
  ContextAccessService,
  InstalledModuleCatalog,
  ModuleEntrypointAccess,
  OntosShellContributions,
  TenantModuleStateServiceContract,
} from '@app/core-runtime';
import { decideModuleStateAccess, isReservedShellRouteRoot, toContextPermissionAccessKey } from '@app/core-runtime';
import type { LegalEntityNavigationExclusionsContract } from '@app/core-runtime/modules/legal-entity-navigation-exclusions';
import { Context, Effect, Layer, Option, Schema } from 'effect';

import { ShellCompositionSchema, ShellNavigationItemSchema } from '../../shared/api.ts';
import type { InstalledModuleCatalogError, ShellInstalledCatalog } from './installed-module-catalog.ts';

const withOptionalProperty = <Base extends object, Key extends PropertyKey, Value, Trailing extends object>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

type ShellPageContribution = OntosShellContributions['pages'][number];
type ShellRenderableContribution = ShellPageContribution | OntosShellContributions['publicComponents'][number];

const shellCompositionUnavailableErrorFields = {
  cause: Schema.optionalKey(Schema.Defect()),
};
const ShellCompositionUnavailableErrorSchema = Schema.TaggedStruct(
  'ShellCompositionUnavailableError',
  shellCompositionUnavailableErrorFields,
);
export type ShellCompositionUnavailableError = typeof ShellCompositionUnavailableErrorSchema.Type;
const ShellCompositionUnavailableErrorConstructor = Schema.TaggedError<ShellCompositionUnavailableError>()(
  'ShellCompositionUnavailableError',
  shellCompositionUnavailableErrorFields,
);
export { ShellCompositionUnavailableErrorConstructor as ShellCompositionUnavailableError };

export interface ShellCompositionContext {
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/** What composition decides before and after its transaction: the approved catalog and SpiceDB access. */
export interface ShellCompositionAccessSources {
  readonly catalog: Effect.Effect<ShellInstalledCatalog, InstalledModuleCatalogError>;
  readonly contextAccess: Pick<ContextAccessService, 'modules' | 'contextPermissions'>;
}

/** What composition reads inside the governed-read transaction: tenant data only. */
export interface ShellCompositionDataSources {
  readonly moduleStates: Pick<TenantModuleStateServiceContract, 'getTenantModuleStates'>;
  /** Destinations the selected company does not offer (tenant data keyed by page entrypoint). */
  readonly navigationExclusions: LegalEntityNavigationExclusionsContract;
}

const isVisibleState = Schema.is(ShellNavigationItemSchema.fields.state);

const loadCatalog = (
  sources: ShellCompositionAccessSources,
): Effect.Effect<ShellInstalledCatalog, ShellCompositionUnavailableError> =>
  sources.catalog.pipe(Effect.mapError((cause) => new ShellCompositionUnavailableErrorConstructor({ cause })));

const loadStates = (
  sources: ShellCompositionDataSources,
  context: ShellCompositionContext,
  moduleIds: readonly string[],
) =>
  sources.moduleStates
    .getTenantModuleStates(context.tenantId, moduleIds)
    .pipe(Effect.mapError((cause) => new ShellCompositionUnavailableErrorConstructor({ cause })));

const pageByContributionKey = (catalog: InstalledModuleCatalog): ReadonlyMap<string, ShellPageContribution> =>
  new Map(
    catalog.contracts.flatMap(({ manifest }) =>
      manifest.publicSurface.shellContributions.pages.map((page) => [page.contributionKey, page] as const),
    ),
  );

const resolveContributionPage = (
  contributions: OntosShellContributions,
  input: { readonly entrypointKey?: string; readonly moduleId: string },
): ShellRenderableContribution | undefined => {
  const { navigation, pages, publicComponents } = contributions;
  if (input.entrypointKey !== undefined) {
    return [...pages, ...publicComponents].find(
      ({ entrypoint }) => entrypoint.entrypointKey === input.entrypointKey && entrypoint.moduleKey === input.moduleId,
    );
  }
  const [landing] = navigation;
  return landing === undefined
    ? undefined
    : pages.find(({ contributionKey }) => String(contributionKey) === String(landing.pageKey));
};

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index);
    if (code !== undefined && (code < 32 || code === 127)) {
      return true;
    }
  }
  return false;
};

export interface ShellModuleTargetSelector {
  readonly canonicalPath?: string;
  readonly compositionRevision?: string;
  readonly entrypointKey?: string;
  readonly moduleId?: string;
}

/** Canonical paths are untrusted selectors, never identity or transport configuration. */
const canonicalSegments = (path: string, template = false): readonly string[] | undefined => {
  if (
    path.length === 0 ||
    path.length > (template ? 200 : 40_000) ||
    !path.startsWith('/') ||
    /[?#\\]/u.test(path) ||
    path.includes('//') ||
    (path !== '/' && path.endsWith('/'))
  ) {
    return undefined;
  }
  const encoded = path.slice(1).split('/');
  if (encoded.length > 64) {
    return undefined;
  }
  const segments: string[] = [];
  for (const segment of encoded) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (
      decoded === '.' ||
      decoded === '..' ||
      decoded.length > 200 ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      hasControlCharacter(decoded)
    ) {
      return undefined;
    }
    segments.push(decoded);
  }
  return segments;
};

const matchCanonicalPage = (
  routePath: string,
  requested: readonly string[],
): Readonly<Record<string, string>> | undefined => {
  const template = canonicalSegments(routePath, true);
  if (template === undefined || template.length !== requested.length || template.length > 64) {
    return undefined;
  }
  const parameters: Record<string, string> = {};
  for (const [index, segment] of template.entries()) {
    const value = requested[index];
    if (value === undefined || value.length === 0) {
      return undefined;
    }
    if (segment.startsWith(':')) {
      const name = segment.slice(1);
      if (
        !/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(name) ||
        Object.hasOwn(parameters, name) ||
        name === 'constructor' ||
        name === 'prototype' ||
        name === '__proto__'
      ) {
        return undefined;
      }
      parameters[name] = value;
    } else if (segment !== value) {
      return undefined;
    }
  }
  return Object.freeze(parameters);
};

const compareCanonicalRoutes = (left: ShellPageContribution, right: ShellPageContribution): number => {
  const leftSegments = left.routePath.split('/');
  const rightSegments = right.routePath.split('/');
  for (const [index, segment] of leftSegments.entries()) {
    const difference = Number(!(rightSegments[index] ?? ':').startsWith(':')) - Number(!segment.startsWith(':'));
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

const resolvePageSelection = (catalog: InstalledModuleCatalog, input: ShellModuleTargetSelector) => {
  if (input.canonicalPath === undefined) {
    if (input.moduleId === undefined) {
      return null;
    }
    const contract = catalog.getByModuleId(input.moduleId);
    const page =
      contract === undefined
        ? undefined
        : resolveContributionPage(contract.manifest.publicSurface.shellContributions, {
            ...input,
            moduleId: input.moduleId,
          });
    return contract === undefined || page === undefined ? null : { contract, page, routeParameters: {} };
  }
  if (input.moduleId !== undefined || input.entrypointKey !== undefined) {
    return null;
  }
  const segments = canonicalSegments(input.canonicalPath);
  if (segments === undefined || isReservedShellRouteRoot(segments[0])) {
    return null;
  }
  const matches = catalog.contracts.flatMap((contract) =>
    contract.manifest.publicSurface.shellContributions.pages.flatMap((page) => {
      const routeParameters = matchCanonicalPage(page.routePath, segments);
      return routeParameters === undefined ? [] : [{ contract, page, routeParameters }];
    }),
  );
  const [selected, next] = matches.toSorted((left, right) => compareCanonicalRoutes(left.page, right.page));
  return selected === undefined || (next !== undefined && compareCanonicalRoutes(selected.page, next.page) === 0)
    ? null
    : selected;
};

const resolveTargetPermission = Effect.fn('ShellComposition.resolveTargetPermission')(function* resolveTargetPermission(
  sources: ShellCompositionAccessSources,
  context: ShellCompositionContext & {
    readonly legalEntityId: string;
    readonly moduleId: string;
  },
) {
  const [permission, ...unexpected] = yield* sources.contextAccess.modules({
    legalEntityId: context.legalEntityId,
    moduleIds: [context.moduleId],
    principalId: context.principalId,
    tenantId: context.tenantId,
  });
  if (unexpected.length > 0 || permission === undefined || permission.key !== context.moduleId) {
    return { outcome: 'unavailable' } as const;
  }
  if (permission.decision === 'unavailable') {
    return { outcome: 'unavailable' } as const;
  }
  if (permission.decision === 'denied') {
    return { outcome: 'forbidden' } as const;
  }
  return null;
});

const matchesComponentExposure = (
  component: { readonly expose: string; readonly mfBoundaryId: string },
  federation: { readonly exposes: readonly string[]; readonly remoteName: string },
  expose: string,
): boolean =>
  federation.exposes.includes(expose) &&
  expose === component.expose &&
  federation.remoteName === component.mfBoundaryId;

/** Public components require their declared permission in addition to module access. */
const resolvePublicComponentPermission = Effect.fn('ShellComposition.resolvePublicComponentPermission')(
  function* resolvePublicComponentPermissionEffect(
    sources: ShellCompositionAccessSources,
    context: ShellCompositionContext,
    page: ShellRenderableContribution,
  ) {
    if (page.entrypoint.role !== 'public_component') {
      return null;
    }
    const { authorization } = page.entrypoint;
    if (authorization.kind === 'authenticated_principal' || authorization.kind === 'public') {
      return null;
    }
    const check = sources.contextAccess.contextPermissions;
    if (authorization.kind !== 'context_permission' || check === undefined) {
      return { outcome: 'unavailable' } as const;
    }
    const target = { moduleId: page.entrypoint.moduleKey, permission: authorization.permission };
    const [decision, ...extra] = yield* check({
      ...context,
      targets: [target],
    });
    if (
      extra.length > 0 ||
      decision?.key !== toContextPermissionAccessKey(target) ||
      decision.decision === 'unavailable'
    ) {
      return { outcome: 'unavailable' } as const;
    }
    return decision.decision === 'denied' ? ({ outcome: 'forbidden' } as const) : null;
  },
);

/**
 * Navigation entries whose page requires a context permission beyond module access (for example restricted
 * agendas) are hidden when that permission is denied. Unavailable decisions keep the current behaviour (listed;
 * the page itself still enforces access).
 */
const resolveDeniedNavigationEntrypoints = Effect.fn('ShellComposition.resolveDeniedNavigationEntrypoints')(
  function* resolveDeniedNavigationEntrypointsEffect(
    sources: ShellCompositionAccessSources,
    context: ShellCompositionContext & { readonly legalEntityId: string },
    catalog: ShellInstalledCatalog,
  ) {
    const check = sources.contextAccess.contextPermissions;
    if (check === undefined) {
      return new Set<string>();
    }
    const targets = new Map<string, { readonly moduleId: string; readonly permission: string }>();
    for (const contract of catalog.contracts) {
      const moduleId = contract.manifest.module.id;
      // Asked for every module so this check runs alongside the module check; denied modules list nothing anyway.
      for (const contribution of contract.manifest.publicSurface.shellContributions.navigation) {
        const { authorization } = contribution.entrypoint;
        if (authorization.kind === 'context_permission' && authorization.permission !== 'module.access') {
          const target = { moduleId, permission: authorization.permission };
          targets.set(toContextPermissionAccessKey(target), target);
        }
      }
    }
    if (targets.size === 0) {
      return new Set<string>();
    }
    const decisions = yield* check({
      legalEntityId: context.legalEntityId,
      principalId: context.principalId,
      targets: [...targets.values()],
      tenantId: context.tenantId,
    });
    return new Set(decisions.flatMap(({ decision, key }) => (decision === 'denied' ? [key] : [])));
  },
);

/** Composition access decided before the transaction: the catalog and both SpiceDB checks, in parallel. */
export type ShellCompositionAuthorization =
  | { readonly state: 'selection_required' }
  | {
      readonly catalog: ShellInstalledCatalog;
      readonly deniedEntrypoints: ReadonlySet<string>;
      readonly legalEntityId: string;
      readonly permissionByModule: ReadonlyMap<string, string>;
      readonly state: 'authorized';
    };

type ModuleState = Effect.Success<
  ReturnType<ShellCompositionDataSources['moduleStates']['getTenantModuleStates']>
>[number]['state'];

/** The tenant data composition read inside its transaction. */
export interface ShellCompositionData {
  readonly excludedEntrypoints: ReadonlySet<string>;
  readonly states: ReadonlyMap<string, ModuleState>;
}

/** A module target whose catalog page and access are decided; its module state is still to be read. */
export type ShellModuleTargetAuthorization =
  | { readonly outcome: 'not_found' | 'reload_required' | 'selection_required' | 'unavailable' }
  | {
      readonly access: ModuleEntrypointAccess;
      readonly appId: string;
      readonly compositionRevision: string;
      readonly denial: { readonly outcome: 'forbidden' | 'unavailable' } | null;
      readonly federation: {
        readonly expose: string;
        readonly manifest: Extract<
          ShellInstalledCatalog['composition']['modules'][number]['federation'],
          { readonly execution: 'browser' }
        >['manifest'];
        readonly remoteName: string;
      };
      readonly moduleId: string;
      readonly outcome: 'candidate';
      readonly page: ShellRenderableContribution;
      readonly routeParameters: Readonly<Record<string, string>>;
    };

const moduleTargetAuthorization = (authorization: ShellModuleTargetAuthorization) => authorization;

/** The transaction step of composition and module targets: scoped tenant data only. */
export const makeShellCompositionData = (sources: ShellCompositionDataSources) => {
  const loadComposition = Effect.fn('ShellCompositionData.loadComposition')(function* loadCompositionEffect(
    context: ShellCompositionContext,
    authorization: ShellCompositionAuthorization,
  ) {
    if (authorization.state !== 'authorized') {
      return {
        excludedEntrypoints: new Set<string>(),
        states: new Map<string, ModuleState>(),
      } satisfies ShellCompositionData;
    }
    // Sequential on purpose: both reads share the governed read's Core transaction.
    const { excludedEntrypoints, records } = yield* Effect.all(
      {
        records: loadStates(sources, context, authorization.catalog.moduleIds),
        excludedEntrypoints: sources.navigationExclusions
          .listExcludedEntrypoints(context.tenantId, authorization.legalEntityId)
          .pipe(Effect.mapError((cause) => new ShellCompositionUnavailableErrorConstructor({ cause }))),
      },
      { concurrency: 1 },
    );
    return {
      excludedEntrypoints,
      states: new Map(records.map(({ moduleKey, state }) => [moduleKey, state])),
    } satisfies ShellCompositionData;
  });

  const loadModuleTarget = Effect.fn('ShellCompositionData.loadModuleTarget')(function* loadModuleTargetEffect(
    context: ShellCompositionContext,
    authorization: ShellModuleTargetAuthorization,
  ) {
    if (authorization.outcome !== 'candidate') {
      return Option.none<ModuleState>();
    }
    const [record] = yield* loadStates(sources, context, [authorization.moduleId]);
    return record?.moduleKey === authorization.moduleId ? Option.some(record.state) : Option.none<ModuleState>();
  });

  return Object.freeze({ loadComposition, loadModuleTarget });
};

/** After commit: the module state read inside the transaction decides before the access outcome. */
const finishShellModuleTarget = (authorization: ShellModuleTargetAuthorization, state: Option.Option<ModuleState>) => {
  if (authorization.outcome !== 'candidate') {
    return authorization;
  }
  if (Option.isNone(state) || decideModuleStateAccess(state.value, authorization.access) === 'deny') {
    return { outcome: 'not_found' } as const;
  }
  if (authorization.denial !== null) {
    return authorization.denial;
  }
  return {
    appId: authorization.appId,
    compositionRevision: authorization.compositionRevision,
    federation: authorization.federation,
    moduleId: authorization.moduleId,
    outcome: 'resolved',
    page: authorization.page,
    routeParameters: authorization.routeParameters,
    writable: state.value === 'active',
  } as const;
};

/** The steps of composition and module targets around the transaction: catalog and SpiceDB, no database. */
export const makeShellCompositionAccess = (sources: ShellCompositionAccessSources) => {
  const authorizeComposition = Effect.fn('ShellCompositionAccess.authorizeComposition')(
    function* authorizeCompositionEffect(context: ShellCompositionContext) {
      if (context.legalEntityId === undefined) {
        return { state: 'selection_required' } as const satisfies ShellCompositionAuthorization;
      }
      const catalog = yield* loadCatalog(sources);
      const { moduleIds } = catalog;
      const { decisions, deniedEntrypoints } = yield* Effect.all(
        {
          decisions: sources.contextAccess.modules({
            legalEntityId: context.legalEntityId,
            moduleIds,
            principalId: context.principalId,
            tenantId: context.tenantId,
          }),
          deniedEntrypoints: resolveDeniedNavigationEntrypoints(
            sources,
            { ...context, legalEntityId: context.legalEntityId },
            catalog,
          ),
        },
        { concurrency: 2 },
      );
      if (decisions.length !== moduleIds.length || decisions.some(({ key }, index) => key !== moduleIds[index])) {
        return yield* new ShellCompositionUnavailableErrorConstructor();
      }
      return {
        catalog,
        deniedEntrypoints,
        legalEntityId: context.legalEntityId,
        permissionByModule: new Map(decisions.map(({ decision, key }) => [key, decision])),
        state: 'authorized',
      } as const satisfies ShellCompositionAuthorization;
    },
  );

  const finishComposition = Effect.fn('ShellCompositionAccess.finishComposition')(function* finishCompositionEffect(
    authorization: ShellCompositionAuthorization,
    data: ShellCompositionData,
  ) {
    if (authorization.state !== 'authorized') {
      return { navigation: [], state: 'selection_required' } as const;
    }
    const { catalog, deniedEntrypoints, permissionByModule } = authorization;
    const { excludedEntrypoints, states } = data;
    const pages = pageByContributionKey(catalog);
    const navigation = catalog.contracts.flatMap((contract) => {
      const moduleId = contract.manifest.module.id;
      const state = states.get(moduleId);
      const permission = permissionByModule.get(moduleId);
      if (state === undefined || !isVisibleState(state) || permission === undefined || permission === 'denied') {
        return [];
      }
      return contract.manifest.publicSurface.shellContributions.navigation.flatMap((contribution) => {
        const { authorization, entrypointKey } = contribution.entrypoint;
        if (
          excludedEntrypoints.has(entrypointKey) ||
          (authorization.kind === 'context_permission' &&
            deniedEntrypoints.has(toContextPermissionAccessKey({ moduleId, permission: authorization.permission })))
        ) {
          return [];
        }
        const page = pages.get(contribution.pageKey);
        const unavailable = permission === 'unavailable' || page === undefined;
        return [
          withOptionalProperty(
            {
              appId: contract.deployment.appId,
              enabled: !unavailable,
              entrypointKey: contribution.entrypoint.entrypointKey,
              groupKey: contribution.groupKey,
              homeStart: contribution.homeStart,
            },
            !unavailable,
            'href',
            page?.routePath ?? '',
            {
              icon: contribution.icon,
              label: contribution.label,
              moduleId,
              order: Number(contribution.order),
              requiresCapability: contribution.requiresCapability,
              state,
              unavailable,
              writable: state === 'active',
            },
          ),
        ];
      });
    });
    const appIds = [...new Set(catalog.contracts.map((contract) => contract.deployment.appId))].toSorted();
    // A deployment counts as denied only when access to every module it serves is definitely denied.
    const deniedAppIds = appIds.filter((appId) =>
      catalog.contracts.every(
        (contract) =>
          contract.deployment.appId !== appId || permissionByModule.get(contract.manifest.module.id) === 'denied',
      ),
    );
    const denied = new Set(deniedAppIds);
    const unavailableAppIds = new Set(
      catalog.deploymentStatuses.flatMap((deployment) => (deployment.status === 'available' ? [] : [deployment.appId])),
    );
    const composition = yield* Schema.decodeEffect(ShellCompositionSchema)({
      compositionRevision: catalog.composition.revision,
      deniedAppIds,
      gatewayAudiences: appIds.filter((appId) => !denied.has(appId) && !unavailableAppIds.has(appId)),
      homeComponents: catalog.contracts
        .flatMap((contract) => {
          const permission = permissionByModule.get(contract.manifest.module.id);
          return permission === 'allowed'
            ? contract.manifest.publicSurface.shellContributions.publicComponents.flatMap(({ entrypoint, home }) =>
                home === undefined
                  ? []
                  : [
                      {
                        entrypointKey: entrypoint.entrypointKey,
                        moduleId: entrypoint.moduleKey,
                        order: Number(home.order),
                        requiresModules: home.requiresModules,
                      },
                    ],
              )
            : [];
        })
        .toSorted((left, right) => left.order - right.order || left.entrypointKey.localeCompare(right.entrypointKey)),
      navigation: navigation.toSorted(
        (left, right) =>
          left.order - right.order ||
          left.label.cs.localeCompare(right.label.cs) ||
          left.moduleId.localeCompare(right.moduleId),
      ),
      state: 'available',
      unavailableDeployments: catalog.deploymentStatuses.flatMap((deployment) =>
        deployment.status === 'available'
          ? []
          : [
              deployment.status === 'unavailable'
                ? {
                    appId: deployment.appId,
                    reason: deployment.reason,
                    status: deployment.status,
                  }
                : { appId: deployment.appId, status: deployment.status },
            ],
      ),
    }).pipe(Effect.mapError((cause) => new ShellCompositionUnavailableErrorConstructor({ cause })));
    if (composition.state !== 'available') {
      return yield* new ShellCompositionUnavailableErrorConstructor({
        cause: 'Shell composition decoded to an unexpected state',
      });
    }
    return composition;
  });

  const authorizeModuleTarget = Effect.fn('ShellCompositionAccess.authorizeModuleTarget')(
    function* authorizeModuleTargetEffect(
      context: ShellCompositionContext,
      input: {
        readonly access?: ModuleEntrypointAccess;
        readonly canonicalPath?: string;
        readonly compositionRevision?: string;
        readonly entrypointKey?: string;
        readonly moduleId?: string;
      },
    ) {
      if (context.legalEntityId === undefined) {
        return moduleTargetAuthorization({ outcome: 'selection_required' });
      }
      const catalog = yield* loadCatalog(sources);
      if (input.compositionRevision !== undefined && input.compositionRevision !== catalog.composition.revision) {
        return moduleTargetAuthorization({ outcome: 'reload_required' });
      }
      const selected = resolvePageSelection(catalog, input);
      if (selected === null) {
        // An unknown module, page or path is "not found"; module-level denial is decided below for real targets.
        return moduleTargetAuthorization({ outcome: 'not_found' });
      }
      const { contract, page, routeParameters } = selected;
      const moduleId = contract.manifest.module.id;
      const approvedModule = catalog.composition.modules.find((module) => module.moduleId === moduleId);
      const component = contract.manifest.publicSurface.components.find(({ key }) => key === page.componentKey);
      if (approvedModule?.federation.execution !== 'browser' || component === undefined) {
        return moduleTargetAuthorization({ outcome: 'unavailable' });
      }
      if (!matchesComponentExposure(component, approvedModule.federation, page.expose)) {
        return moduleTargetAuthorization({ outcome: 'unavailable' });
      }
      // Module access and the public component's own permission are independent SpiceDB checks.
      const [permission, publicPermission] = yield* Effect.all(
        [
          resolveTargetPermission(sources, {
            legalEntityId: context.legalEntityId,
            moduleId,
            principalId: context.principalId,
            tenantId: context.tenantId,
          }),
          resolvePublicComponentPermission(sources, context, page),
        ],
        { concurrency: 2 },
      );
      return moduleTargetAuthorization({
        access: input.access ?? page.entrypoint.access,
        appId: contract.deployment.appId,
        compositionRevision: catalog.composition.revision,
        denial: permission ?? publicPermission,
        federation: {
          expose: page.expose,
          manifest: approvedModule.federation.manifest,
          remoteName: approvedModule.federation.remoteName,
        },
        moduleId,
        outcome: 'candidate',
        page,
        routeParameters,
      });
    },
  );

  /**
   * Asks SpiceDB, in one round trip, for every decision a composition read of the captured release checks: the read
   * entrypoint's module access, each module's access and the navigation permissions. Run beside the read under
   * `withRequestPermissionDecisions`, the read's own checks join these decisions instead of paying a round trip each
   * (scope, entrypoint and composition checks were three sequential round trips). Failures are the read's to report.
   */
  const prefetchCompositionDecisions = (context: ShellCompositionContext, entrypointModuleId: string) =>
    Effect.gen(function* prefetchCompositionDecisionsEffect() {
      const { legalEntityId } = context;
      if (legalEntityId === undefined) {
        return;
      }
      const catalog = yield* loadCatalog(sources);
      yield* Effect.all(
        [
          sources.contextAccess.modules({
            legalEntityId,
            moduleIds: [...new Set([entrypointModuleId, ...catalog.moduleIds])],
            principalId: context.principalId,
            tenantId: context.tenantId,
          }),
          resolveDeniedNavigationEntrypoints(sources, { ...context, legalEntityId }, catalog),
        ],
        { concurrency: 2, discard: true },
      );
    }).pipe(Effect.ignore);

  /** The module target's counterpart of `prefetchCompositionDecisions`: the entrypoint, target module and page checks. */
  const prefetchModuleTargetDecisions = (
    context: ShellCompositionContext,
    input: Parameters<typeof authorizeModuleTarget>[1],
    entrypointModuleId: string,
  ) =>
    Effect.gen(function* prefetchModuleTargetDecisionsEffect() {
      const { legalEntityId } = context;
      if (legalEntityId === undefined) {
        return;
      }
      const selected = resolvePageSelection(yield* loadCatalog(sources), input);
      if (selected === null) {
        return;
      }
      yield* Effect.all(
        [
          sources.contextAccess.modules({
            legalEntityId,
            moduleIds: [...new Set([entrypointModuleId, selected.contract.manifest.module.id])],
            principalId: context.principalId,
            tenantId: context.tenantId,
          }),
          resolvePublicComponentPermission(sources, context, selected.page),
        ],
        { concurrency: 2, discard: true },
      );
    }).pipe(Effect.ignore);

  return Object.freeze({
    authorizeComposition,
    authorizeModuleTarget,
    finishComposition,
    finishModuleTarget: finishShellModuleTarget,
    prefetchCompositionDecisions,
    prefetchModuleTargetDecisions,
  });
};

export interface ShellCompositionFactoryService {
  readonly access: typeof makeShellCompositionAccess;
  readonly data: typeof makeShellCompositionData;
}

export class ShellCompositionFactory extends Context.Service<ShellCompositionFactory, ShellCompositionFactoryService>()(
  '@app/shell-super-app/api/modules/shell-composition/ShellCompositionFactory',
) {}

export const ShellCompositionFactoryLive = Layer.succeed(
  ShellCompositionFactory,
  Object.freeze({ access: makeShellCompositionAccess, data: makeShellCompositionData }),
);
