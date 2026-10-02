import type {
  ContextAccessService,
  InstalledModuleCatalog,
  ModuleEntrypointAccess,
  OntosShellContributions,
  TenantModuleStateServiceContract,
} from '@app/core-runtime';
import { decideModuleStateAccess, isReservedShellRouteRoot } from '@app/core-runtime';
import { Context, Effect, Layer, Schema } from 'effect';

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

export interface ShellCompositionSources {
  readonly catalog: Effect.Effect<ShellInstalledCatalog, InstalledModuleCatalogError>;
  readonly contextAccess: Pick<ContextAccessService, 'modules'>;
  readonly moduleStates: Pick<TenantModuleStateServiceContract, 'getTenantModuleStates'>;
}

const isVisibleState = Schema.is(ShellNavigationItemSchema.fields.state);

const loadCatalog = (
  sources: ShellCompositionSources,
): Effect.Effect<ShellInstalledCatalog, ShellCompositionUnavailableError> =>
  sources.catalog.pipe(Effect.mapError((cause) => new ShellCompositionUnavailableErrorConstructor({ cause })));

const loadStates = (sources: ShellCompositionSources, context: ShellCompositionContext, moduleIds: readonly string[]) =>
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
): ShellPageContribution | undefined => {
  const { navigation, pages } = contributions;
  if (input.entrypointKey !== undefined) {
    return pages.find(
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
  sources: ShellCompositionSources,
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

export const makeShellComposition = (sources: ShellCompositionSources) => {
  const compose = Effect.fn('makeShellComposition.compose')(function* composeShellEffect(
    context: ShellCompositionContext,
  ) {
    if (context.legalEntityId === undefined) {
      return { navigation: [], state: 'selection_required' } as const;
    }
    const catalog = yield* loadCatalog(sources);
    const { moduleIds } = catalog;
    const records = yield* loadStates(sources, context, moduleIds);
    const states = new Map(records.map(({ moduleKey, state }) => [moduleKey, state]));
    const decisions = yield* sources.contextAccess.modules({
      legalEntityId: context.legalEntityId,
      moduleIds,
      principalId: context.principalId,
      tenantId: context.tenantId,
    });
    if (decisions.length !== moduleIds.length || decisions.some(({ key }, index) => key !== moduleIds[index])) {
      return yield* new ShellCompositionUnavailableErrorConstructor();
    }
    const permissionByModule = new Map(decisions.map(({ decision, key }) => [key, decision]));
    const pages = pageByContributionKey(catalog);
    const navigation = catalog.contracts.flatMap((contract) => {
      const moduleId = contract.manifest.module.id;
      const state = states.get(moduleId);
      const permission = permissionByModule.get(moduleId);
      if (state === undefined || !isVisibleState(state) || permission === undefined || permission === 'denied') {
        return [];
      }
      return contract.manifest.publicSurface.shellContributions.navigation.map((contribution) => {
        const page = pages.get(contribution.pageKey);
        const unavailable = permission === 'unavailable' || page === undefined;
        return withOptionalProperty(
          {
            appId: contract.deployment.appId,
            enabled: !unavailable,
            groupKey: contribution.groupKey,
          },
          !unavailable,
          'href',
          page?.routePath ?? '',
          {
            label: contract.manifest.module.displayName,
            moduleId,
            order: Number(contribution.order),
            state,
            unavailable,
            writable: state === 'active',
          },
        );
      });
    });
    const composition = yield* Schema.decodeEffect(ShellCompositionSchema)({
      compositionRevision: catalog.composition.revision,
      navigation: navigation.toSorted(
        (left, right) =>
          left.order - right.order ||
          left.label.localeCompare(right.label) ||
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

  const resolveModuleTarget = Effect.fn('makeShellComposition.resolveModuleTarget')(function* resolveModuleTargetEffect(
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
      return { outcome: 'selection_required' } as const;
    }
    const catalog = yield* loadCatalog(sources);
    if (input.compositionRevision !== undefined && input.compositionRevision !== catalog.composition.revision) {
      return { outcome: 'reload_required' } as const;
    }
    const selected = resolvePageSelection(catalog, input);
    if (selected === null) {
      return { outcome: 'not_found' } as const;
    }
    const { contract, page, routeParameters } = selected;
    const moduleId = contract.manifest.module.id;
    const approvedModule = catalog.composition.modules.find((module) => module.moduleId === moduleId);
    const component = contract.manifest.publicSurface.components.find(({ key }) => key === page.componentKey);
    if (
      approvedModule?.federation.execution !== 'browser' ||
      component === undefined ||
      !approvedModule.federation.exposes.includes(page.expose) ||
      page.expose !== component.expose ||
      approvedModule.federation.remoteName !== component.mfBoundaryId
    ) {
      return { outcome: 'unavailable' } as const;
    }
    const records = yield* loadStates(sources, context, [moduleId]);
    const [record] = records;
    const state = record?.moduleKey === moduleId ? record.state : undefined;
    if (state === undefined) {
      return { outcome: 'not_found' } as const;
    }
    const access = input.access ?? page.entrypoint.access;
    if (decideModuleStateAccess(state, access) === 'deny') {
      return { outcome: 'not_found' } as const;
    }
    const permission = yield* resolveTargetPermission(sources, {
      legalEntityId: context.legalEntityId,
      moduleId,
      principalId: context.principalId,
      tenantId: context.tenantId,
    });
    if (permission !== null) {
      return permission;
    }
    return {
      appId: contract.deployment.appId,
      compositionRevision: catalog.composition.revision,
      federation: {
        expose: page.expose,
        manifest: approvedModule.federation.manifest,
        remoteName: approvedModule.federation.remoteName,
      },
      moduleId,
      outcome: 'resolved',
      page,
      routeParameters,
      writable: state === 'active',
    } as const;
  });

  return Object.freeze({ compose, resolveModuleTarget });
};

export interface ShellCompositionFactoryService {
  readonly create: typeof makeShellComposition;
}

export class ShellCompositionFactory extends Context.Service<ShellCompositionFactory, ShellCompositionFactoryService>()(
  '@app/shell-super-app/api/modules/shell-composition/ShellCompositionFactory',
) {}

export const ShellCompositionFactoryLive = Layer.succeed(
  ShellCompositionFactory,
  Object.freeze({ create: makeShellComposition }),
);
