import type {
  ContextAccessService,
  InstalledModuleCatalog,
  ModuleEntrypointAccess,
  OntosShellContributions,
  TenantModuleStateServiceContract,
} from '@app/core-runtime';
import { decideModuleStateAccess } from '@app/core-runtime';
import { Context, Effect, Layer, Schema } from 'effect';
import { ShellCompositionSchema, ShellNavigationItemSchema } from '../../shared/api.ts';
import type { ShellComposition } from '../../shared/api.ts';
import type { InstalledModuleCatalogError } from './installed-module-catalog.ts';

const withOptionalProperty = <
  Base extends object,
  Key extends PropertyKey,
  Value,
  Trailing extends object,
>(
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
const ShellCompositionUnavailableErrorConstructor =
  Schema.TaggedError<ShellCompositionUnavailableError>()(
    'ShellCompositionUnavailableError',
    shellCompositionUnavailableErrorFields,
  );
export { ShellCompositionUnavailableErrorConstructor as ShellCompositionUnavailableError };

export interface ShellCompositionContext {
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export type ShellCompositionModel = Exclude<ShellComposition, { readonly state: 'access_blocked' }>;

export type ShellTargetResolution =
  | { readonly outcome: 'selection_required' }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'forbidden' }
  | { readonly outcome: 'unavailable' }
  | {
      readonly appId: string;
      readonly moduleId: string;
      readonly outcome: 'resolved';
      readonly page: ShellPageContribution;
      readonly writable: boolean;
    };

export interface ShellCompositionSources {
  readonly catalog: Effect.Effect<InstalledModuleCatalog, InstalledModuleCatalogError>;
  readonly contextAccess: Pick<ContextAccessService, 'modules'>;
  readonly moduleStates: Pick<TenantModuleStateServiceContract, 'getTenantModuleStates'>;
}

const isVisibleState = Schema.is(ShellNavigationItemSchema.fields.state);

const loadCatalog = (
  sources: ShellCompositionSources,
): Effect.Effect<InstalledModuleCatalog, ShellCompositionUnavailableError> =>
  sources.catalog.pipe(
    Effect.mapError((cause) => new ShellCompositionUnavailableErrorConstructor({ cause })),
  );

const loadStates = (
  sources: ShellCompositionSources,
  context: ShellCompositionContext,
  moduleIds: readonly string[],
) =>
  sources.moduleStates
    .getTenantModuleStates(context.tenantId, moduleIds)
    .pipe(Effect.mapError((cause) => new ShellCompositionUnavailableErrorConstructor({ cause })));

const pageByContributionKey = (
  catalog: InstalledModuleCatalog,
): ReadonlyMap<string, ShellPageContribution> =>
  new Map(
    catalog.contracts.flatMap(({ manifest }) =>
      manifest.publicSurface.shellContributions.pages.map(
        (page) => [page.contributionKey, page] as const,
      ),
    ),
  );

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
    if (
      decisions.length !== moduleIds.length ||
      decisions.some(({ key }, index) => key !== moduleIds[index])
    ) {
      return yield* new ShellCompositionUnavailableErrorConstructor();
    }
    const permissionByModule = new Map(decisions.map(({ decision, key }) => [key, decision]));
    const pages = pageByContributionKey(catalog);
    const navigation = catalog.contracts.flatMap((contract) => {
      const moduleId = contract.manifest.module.id;
      const state = states.get(moduleId);
      const permission = permissionByModule.get(moduleId);
      if (
        state === undefined ||
        !isVisibleState(state) ||
        permission === undefined ||
        permission === 'denied'
      ) {
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
    const composition = yield* Schema.decodeUnknownEffect(ShellCompositionSchema)({
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

  const resolveModuleTarget = Effect.fn('makeShellComposition.resolveModuleTarget')(
    function* resolveModuleTargetEffect(
      context: ShellCompositionContext,
      input: {
        readonly access?: ModuleEntrypointAccess;
        readonly entrypointKey?: string;
        readonly moduleId: string;
      },
    ) {
      if (context.legalEntityId === undefined) {
        return { outcome: 'selection_required' } as const;
      }
      const catalog = yield* loadCatalog(sources);
      const contract = catalog.getByModuleId(input.moduleId);
      if (contract === undefined) {
        return { outcome: 'not_found' } as const;
      }
      const { pages } = contract.manifest.publicSurface.shellContributions;
      const { navigation } = contract.manifest.publicSurface.shellContributions;
      const [landing] = navigation;
      const exactPage =
        input.entrypointKey === undefined
          ? undefined
          : pages.find(
              ({ entrypoint }) =>
                entrypoint.entrypointKey === input.entrypointKey &&
                entrypoint.moduleKey === input.moduleId,
            );
      const landingPage =
        landing === undefined
          ? undefined
          : pages.find(
              ({ contributionKey }) => String(contributionKey) === String(landing.pageKey),
            );
      const page = input.entrypointKey === undefined ? landingPage : exactPage;
      if (page === undefined) {
        return { outcome: 'not_found' } as const;
      }
      const records = yield* loadStates(sources, context, [input.moduleId]);
      const [record] = records;
      const state = record?.moduleKey === input.moduleId ? record.state : undefined;
      if (state === undefined) {
        return { outcome: 'not_found' } as const;
      }
      const access = input.access ?? page.entrypoint.access;
      if (decideModuleStateAccess(state, access) === 'deny') {
        return { outcome: 'not_found' } as const;
      }
      const [permission, ...unexpected] = yield* sources.contextAccess.modules({
        legalEntityId: context.legalEntityId,
        moduleIds: [input.moduleId],
        principalId: context.principalId,
        tenantId: context.tenantId,
      });
      if (unexpected.length > 0 || permission === undefined || permission.key !== input.moduleId) {
        return { outcome: 'unavailable' } as const;
      }
      if (permission.decision === 'unavailable') {
        return { outcome: 'unavailable' } as const;
      }
      if (permission.decision === 'denied') {
        return { outcome: 'forbidden' } as const;
      }
      return {
        appId: contract.deployment.appId,
        moduleId: input.moduleId,
        outcome: 'resolved',
        page,
        writable: state === 'active',
      } as const;
    },
  );

  return Object.freeze({ compose, resolveModuleTarget });
};

export interface ShellCompositionFactoryService {
  readonly create: typeof makeShellComposition;
}

export class ShellCompositionFactory extends Context.Service<
  ShellCompositionFactory,
  ShellCompositionFactoryService
>()('@app/shell-super-app/api/modules/shell-composition/ShellCompositionFactory') {}

export const ShellCompositionFactoryLive = Layer.succeed(
  ShellCompositionFactory,
  Object.freeze({ create: makeShellComposition }),
);
