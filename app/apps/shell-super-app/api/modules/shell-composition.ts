import type {
  InstalledModuleCatalog,
  ModuleEntrypointAccess,
  OntosShellContributions,
  OperationalScope,
  TenantModuleStateServiceContract,
} from '@app/core-runtime';
import { decideModuleStateAccess, isReservedShellRouteRoot } from '@app/core-runtime';
import type { GateInput } from '@app/core-runtime/access/enforcement';
import type { LegalEntityNavigationExclusionsContract } from '@app/core-runtime/modules/legal-entity-navigation-exclusions';
import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect';

import { ShellCompositionSchema, ShellNavigationItemSchema } from '../../shared/browser-api.ts';
import type { ShellAccessDecision, ShellAccessGate } from './shell-access-decisions.ts';
import {
  isScopeMismatch,
  isVisibleDecision,
  shellAccessOutcome,
  shellLegalEntityScope,
} from './shell-access-decisions.ts';
import type { InstalledModuleCatalogError, ShellInstalledCatalog } from './installed-module-catalog.ts';

const withOptionalProperty = <Base extends object, Key extends PropertyKey, Value, Trailing extends object>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

const matchesComponentExposure = (
  component: { readonly expose: string; readonly mfBoundaryId: string },
  federation: { readonly exposes: readonly string[]; readonly remoteName: string },
  expose: string,
): boolean =>
  federation.exposes.includes(expose) &&
  expose === component.expose &&
  federation.remoteName === component.mfBoundaryId;

type ShellPageContribution = OntosShellContributions['pages'][number];
export type ShellRenderableContribution = ShellPageContribution | OntosShellContributions['publicComponents'][number];

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

/** Every Shell composition question is asked of the trusted request scope, never of loose ids (O66). */
export type ShellCompositionContext = OperationalScope;

/**
 * What composition decides before and after its transaction: the approved catalog and the one access
 * gate. Page admission is the gate's own v2 answer (O7, O12, O28) — the Shell never keeps a second
 * permission path beside it.
 */
export interface ShellCompositionAccessSources {
  readonly access: ShellAccessGate;
  readonly catalog: Effect.Effect<ShellInstalledCatalog, InstalledModuleCatalogError>;
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
  /** An explicit module-state access override from the caller; the page's own access is the default. */
  readonly access?: ModuleEntrypointAccess;
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

const targetKindForLogs = (input: ShellModuleTargetSelector) => {
  if (input.canonicalPath !== undefined) {
    return 'canonical_path';
  }
  return input.entrypointKey === undefined ? 'module_landing' : 'entrypoint';
};

/** Only catalog-owned keys and route templates reach logs, never requested resource IDs or arbitrary input. */
export const moduleTargetSelectorForLogs = (catalog: InstalledModuleCatalog, input: ShellModuleTargetSelector) => {
  const selected = resolvePageSelection(catalog, input);
  const targetKind = targetKindForLogs(input);
  if (selected !== null) {
    return {
      targetAppKey: selected.contract.deployment.appId.slice(0, 120),
      targetKey: selected.page.entrypoint.entrypointKey.slice(0, 200),
      targetKind,
      targetModuleKey: selected.contract.manifest.module.id.slice(0, 120),
      targetRoute: 'routePath' in selected.page ? selected.page.routePath.slice(0, 200) : 'public_component',
    };
  }
  if (input.moduleId !== undefined) {
    const contract = catalog.getByModuleId(input.moduleId);
    if (contract !== undefined) {
      return {
        targetAppKey: contract.deployment.appId.slice(0, 120),
        targetKey: 'unknown',
        targetKind,
        targetModuleKey: contract.manifest.module.id.slice(0, 120),
        targetRoute: 'unknown',
      };
    }
  }
  const root = input.canonicalPath === undefined ? undefined : canonicalSegments(input.canonicalPath)?.[0];
  if (root !== undefined && isReservedShellRouteRoot(root)) {
    return {
      targetAppKey: 'shell-super-app',
      targetKey: root,
      targetKind,
      targetModuleKey: 'core.shell',
      targetRoute: `/${root}`,
    };
  }
  return {
    targetAppKey: 'unknown',
    targetKey: 'unknown',
    targetKind,
    targetModuleKey: 'unknown',
    targetRoute: 'unknown',
  };
};

/**
 * One page or public-component open, as the access gate asks it: the contribution's own declaration
 * (one entrypoint, one capability), in the context that contribution belongs to.
 */
const pageGateInput = (scope: ShellCompositionContext, page: ShellRenderableContribution, now: Date): GateInput => ({
  carrier: { accessDeclaration: page.accessDeclaration },
  legalEntityScope:
    'legalEntityScope' in page && page.legalEntityScope === 'optional'
      ? 'optional'
      : shellLegalEntityScope(page.accessDeclaration),
  now,
  scope,
});

/**
 * Only a protected contribution is asked of the gate: a page that is merely `authenticated_principal`
 * or `public` carries no declaration and is visible to any authenticated person, exactly as it was
 * before the cutover. Asking the gate for it would turn a missing declaration into a denial the
 * classification never asked for.
 */
const isProtectedContribution = (contribution: ShellRenderableContribution): boolean =>
  contribution.entrypoint.authorization.kind === 'protected';

/**
 * Composition access decided before the transaction: the catalog and one gate snapshot over every
 * protected navigation item and home component. `decisions` is keyed by contribution key and carries
 * the gate's own answer per contribution; a key it does not name was never gated (an unprotected
 * contribution carries no capability to ask). `deniedModules` names the modules whose every gated
 * contribution is definitely denied, which is what the browser hint `deniedAppIds` projects.
 */
export interface ShellCompositionAuthorization {
  readonly catalog: ShellInstalledCatalog;
  readonly decisions: ReadonlyMap<string, ShellAccessDecision>;
  readonly deniedModules: ReadonlySet<string>;
  readonly legalEntityId?: string;
  readonly state: 'authorized';
}

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
      readonly denial: { readonly outcome: 'forbidden' | 'selection_required' | 'unavailable' } | null;
      readonly federation: ShellModuleTargetFederation;
      readonly moduleId: string;
      readonly outcome: 'candidate';
      readonly page: ShellRenderableContribution;
      readonly routeParameters: Readonly<Record<string, string>>;
    };

/** The approved browser remote of a module target that the catalog confirms. */
export interface ShellModuleTargetFederation {
  readonly expose: string;
  readonly manifest: Extract<
    ShellInstalledCatalog['composition']['modules'][number]['federation'],
    { readonly execution: 'browser' }
  >['manifest'];
  readonly remoteName: string;
}

/**
 * The finished module-target decision: either a resolved browser page, or the exact reason no target may open
 * (`forbidden`, `not_found`, `reload_required`, `selection_required`, `unavailable`).
 */
export type ShellModuleTargetResolution =
  | { readonly outcome: 'forbidden' | 'not_found' | 'reload_required' | 'selection_required' | 'unavailable' }
  | {
      readonly appId: string;
      readonly compositionRevision: string;
      readonly federation: ShellModuleTargetFederation;
      readonly moduleId: string;
      readonly outcome: 'resolved';
      readonly page: ShellRenderableContribution;
      readonly routeParameters: Readonly<Record<string, string>>;
      readonly writable: boolean;
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
    // Company-specific destinations exist only in a selected company; a tenant-context document has none.
    const { legalEntityId } = authorization;
    // Sequential on purpose: both reads share the governed read's Core transaction.
    const { excludedEntrypoints, records } = yield* Effect.all(
      {
        excludedEntrypoints:
          legalEntityId === undefined
            ? Effect.succeed(new Set<string>())
            : sources.navigationExclusions
                .listExcludedEntrypoints(context.tenantId, legalEntityId)
                .pipe(Effect.mapError((cause) => new ShellCompositionUnavailableErrorConstructor({ cause }))),
        records: loadStates(sources, context, authorization.catalog.moduleIds),
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
const finishShellModuleTarget = (
  authorization: ShellModuleTargetAuthorization,
  state: Option.Option<ModuleState>,
): ShellModuleTargetResolution => {
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

/** Navigation and home contributions of one captured release, decided in one gate snapshot. */
const gatedContributions = (catalog: ShellInstalledCatalog) => {
  const pages = pageByContributionKey(catalog);
  const gated: {
    readonly contribution: ShellRenderableContribution;
    readonly contributionKey: string;
    readonly moduleId: string;
  }[] = [];
  for (const contract of catalog.contracts) {
    const moduleId = contract.manifest.module.id;
    const contributions = contract.manifest.publicSurface.shellContributions;
    for (const navigation of contributions.navigation) {
      const page = pages.get(navigation.pageKey);
      if (page !== undefined && isProtectedContribution(page)) {
        gated.push({ contribution: page, contributionKey: String(navigation.contributionKey), moduleId });
      }
    }
    for (const component of contributions.publicComponents) {
      if (component.home !== undefined && isProtectedContribution(component)) {
        gated.push({ contribution: component, contributionKey: String(component.contributionKey), moduleId });
      }
    }
  }
  return gated;
};

/** The steps of composition and module targets around the transaction: the catalog and one gate snapshot, no database. */
export const makeShellCompositionAccess = (sources: ShellCompositionAccessSources) => {
  /** The gate's answer for one contribution, as the Shell's own denial vocabulary; `null` when it may open. */
  const contributionDenial = Effect.fn('ShellCompositionAccess.contributionDenial')(function* contributionDenialEffect(
    context: ShellCompositionContext,
    contribution: ShellRenderableContribution,
  ) {
    if (!isProtectedContribution(contribution)) {
      return null;
    }
    const now = yield* DateTime.nowAsDate;
    const outcome = shellAccessOutcome(yield* sources.access.decide(pageGateInput(context, contribution, now)));
    return outcome === 'allowed' ? null : { outcome };
  });

  const authorizeComposition = Effect.fn('ShellCompositionAccess.authorizeComposition')(
    function* authorizeCompositionEffect(context: ShellCompositionContext) {
      const catalog = yield* loadCatalog(sources);
      const gated = gatedContributions(catalog);
      const now = yield* DateTime.nowAsDate;
      const decisions = yield* sources.access.decideMany(
        gated.map(({ contribution }) => pageGateInput(context, contribution, now)),
      );
      if (decisions.length !== gated.length) {
        return yield* new ShellCompositionUnavailableErrorConstructor();
      }
      const decisionOf = new Map<string, ShellAccessDecision>();
      const deniedByModule = new Map<string, boolean>();
      for (const [index, entry] of gated.entries()) {
        const decision = decisions[index];
        if (decision === undefined) {
          return yield* new ShellCompositionUnavailableErrorConstructor();
        }
        decisionOf.set(entry.contributionKey, decision);
        // A module counts as denied only when every capability asked of it is definitely denied; a
        // scope mismatch means "ask for a company", never a denial (O28).
        const denied = decision.outcome === 'DENIED' && !isScopeMismatch(decision);
        deniedByModule.set(entry.moduleId, (deniedByModule.get(entry.moduleId) ?? true) && denied);
      }
      const authorization = {
        catalog,
        decisions: decisionOf,
        deniedModules: new Set([...deniedByModule].flatMap(([moduleId, denied]) => (denied ? [moduleId] : []))),
        state: 'authorized',
      } as const satisfies ShellCompositionAuthorization;
      if (context.legalEntityId === undefined) {
        return authorization;
      }
      return { ...authorization, legalEntityId: context.legalEntityId };
    },
  );

  const finishComposition = Effect.fn('ShellCompositionAccess.finishComposition')(function* finishCompositionEffect(
    authorization: ShellCompositionAuthorization,
    data: ShellCompositionData,
  ) {
    const { catalog, decisions, deniedModules } = authorization;
    const { excludedEntrypoints, states } = data;
    const pages = pageByContributionKey(catalog);
    const approvedModules = new Map(catalog.composition.modules.map((module) => [module.moduleId, module] as const));
    /** The page's approved remote, when it is browser code whose exposure the catalog confirms. */
    const pageRemote = (
      contract: (typeof catalog.contracts)[number],
      page: ShellRenderableContribution | undefined,
    ) => {
      const approvedModule = approvedModules.get(contract.manifest.module.id);
      const component =
        page === undefined
          ? undefined
          : contract.manifest.publicSurface.components.find(({ key }) => key === page.componentKey);
      return page === undefined ||
        component === undefined ||
        approvedModule?.federation.execution !== 'browser' ||
        !matchesComponentExposure(component, approvedModule.federation, page.expose)
        ? undefined
        : {
            expose: page.expose,
            manifest: {
              sha256: approvedModule.federation.manifest.sha256,
              url: approvedModule.federation.manifest.url,
            },
            remoteName: approvedModule.federation.remoteName,
          };
    };
    // A navigation item whose capability the gate answered with a scope mismatch is the frame's signal to ask
    // for a company; a definite denial contributes nothing at all.
    let gatedNavigation = 0;
    let scopeMismatchedNavigation = 0;
    const navigation = catalog.contracts.flatMap((contract) => {
      const moduleId = contract.manifest.module.id;
      const state = states.get(moduleId);
      if (state === undefined || !isVisibleState(state)) {
        return [];
      }
      return contract.manifest.publicSurface.shellContributions.navigation.flatMap((contribution) => {
        if (excludedEntrypoints.has(contribution.entrypoint.entrypointKey)) {
          return [];
        }
        const page = pages.get(contribution.pageKey);
        const decision = decisions.get(String(contribution.contributionKey));
        if (decision !== undefined) {
          gatedNavigation += 1;
          if (isScopeMismatch(decision)) {
            scopeMismatchedNavigation += 1;
            return [];
          }
          if (decision.outcome !== 'UNAVAILABLE' && !isVisibleDecision(decision)) {
            return [];
          }
        }
        const unavailable = decision === undefined ? page === undefined : decision.outcome === 'UNAVAILABLE';
        const enabled = !unavailable && (decision === undefined || decision.outcome === 'ALLOWED');
        const remote = enabled ? pageRemote(contract, page) : undefined;
        let item: typeof ShellNavigationItemSchema.Encoded = withOptionalProperty(
          {
            appId: contract.deployment.appId,
            enabled,
            entrypointKey: contribution.entrypoint.entrypointKey,
            groupKey: contribution.groupKey,
          },
          enabled,
          'href',
          page?.routePath ?? '',
          {
            icon: contribution.icon,
            label: contribution.label,
            moduleId,
            order: Number(contribution.order),
            state,
            unavailable,
            writable: state === 'active',
          },
        );
        if (contribution.homeStart !== undefined) {
          item = { ...item, homeStart: contribution.homeStart };
        }
        if (contribution.requiresCapability !== undefined) {
          item = { ...item, requiresCapability: contribution.requiresCapability };
        }
        return remote === undefined ? [item] : [{ ...item, remote }];
      });
    });
    if (navigation.length === 0 && gatedNavigation > 0 && gatedNavigation === scopeMismatchedNavigation) {
      // Nothing is visible because nothing was asked in a company context: ask for a company (O28).
      return { navigation: [], state: 'selection_required' } as const;
    }
    const appIds = [...new Set(catalog.contracts.map((contract) => contract.deployment.appId))].toSorted();
    // A deployment counts as denied only when access to every module it serves is definitely denied.
    const deniedAppIds = appIds.filter((appId) =>
      catalog.contracts.every(
        (contract) => contract.deployment.appId !== appId || deniedModules.has(contract.manifest.module.id),
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
        .flatMap((contract) =>
          contract.manifest.publicSurface.shellContributions.publicComponents.flatMap(
            ({ contributionKey, entrypoint, home }) =>
              home === undefined || decisions.get(String(contributionKey))?.outcome !== 'ALLOWED'
                ? []
                : [
                    {
                      entrypointKey: entrypoint.entrypointKey,
                      moduleId: entrypoint.moduleKey,
                      order: Number(home.order),
                      requiresModules: home.requiresModules,
                    },
                  ],
          ),
        )
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

  /**
   * The catalog, page and exposure steps a module target needs, then the gate's own answer for the page.
   * A missing company is the frame's `selection_required`, never an inferred grant.
   */
  const authorizeTarget = Effect.fn('ShellCompositionAccess.authorizeTarget')(function* authorizeTargetEffect(
    context: ShellCompositionContext,
    input: ShellModuleTargetSelector,
  ) {
    const catalog = yield* loadCatalog(sources);
    if (input.compositionRevision !== undefined && input.compositionRevision !== catalog.composition.revision) {
      return moduleTargetAuthorization({ outcome: 'reload_required' });
    }
    const selected = resolvePageSelection(catalog, input);
    if (selected === null) {
      // An unknown module, page or path is "not found"; access is decided only for a real target.
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
    const denial = yield* contributionDenial(context, page);
    return moduleTargetAuthorization({
      access: input.access ?? page.entrypoint.access,
      appId: contract.deployment.appId,
      compositionRevision: catalog.composition.revision,
      denial,
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
  });

  /** The company read of one module target: a company is required before the gate is asked. */
  const authorizeModuleTarget = (context: ShellCompositionContext, input: ShellModuleTargetSelector) =>
    context.legalEntityId === undefined
      ? Effect.succeed(moduleTargetAuthorization({ outcome: 'selection_required' as const }))
      : authorizeTarget(context, input);

  /** The tenant read of one module target: only a company-less context reaches it. */
  const authorizeTenantModuleTarget = (context: ShellCompositionContext, input: ShellModuleTargetSelector) => {
    if (context.legalEntityId === undefined) {
      return authorizeTarget(context, input);
    }
    return Effect.succeed(moduleTargetAuthorization({ outcome: 'selection_required' as const }));
  };

  /**
   * Warms the gate's decisions for the contributions a composition read will ask, inside the same
   * request-scoped decision window as the read itself. It grants nothing: the read's own authorize step
   * asks the same questions and acts on the answers.
   */
  const prefetchCompositionDecisions = (context: ShellCompositionContext) =>
    Effect.gen(function* prefetchCompositionDecisionsEffect() {
      const gated = gatedContributions(yield* loadCatalog(sources));
      if (gated.length === 0) {
        return;
      }
      const now = yield* DateTime.nowAsDate;
      yield* sources.access.decideMany(gated.map(({ contribution }) => pageGateInput(context, contribution, now)));
    }).pipe(Effect.ignore);

  /** The module target's counterpart of `prefetchCompositionDecisions`: the entrypoint page's own question. */
  const prefetchModuleTargetDecisions = (context: ShellCompositionContext, input: ShellModuleTargetSelector) =>
    Effect.gen(function* prefetchModuleTargetDecisionsEffect() {
      const selected = resolvePageSelection(yield* loadCatalog(sources), input);
      if (selected === null || !isProtectedContribution(selected.page)) {
        return;
      }
      const now = yield* DateTime.nowAsDate;
      yield* sources.access.decide(pageGateInput(context, selected.page, now));
    }).pipe(Effect.ignore);

  return Object.freeze({
    authorizeComposition,
    authorizeModuleTarget,
    authorizeTenantModuleTarget,
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
