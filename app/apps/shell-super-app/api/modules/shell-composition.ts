// @effect-diagnostics anyUnknownInErrorContext:off
/* eslint-disable max-classes-per-file, prefer-destructuring -- Shell composition owns one closed safe-failure vocabulary and keeps correlation access explicit. */
import type {
  ContextAccessService,
  InstalledModuleCatalog,
  ModuleEntrypointAccess,
  OntosShellContributions,
  TenantModuleState,
  TenantModuleStateServiceContract,
} from '@app/core-runtime';
import { decideModuleStateAccess } from '@app/core-runtime';
import { Context, Effect, Layer, Schema } from 'effect';

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

export class ShellCompositionUnavailableError extends Schema.TaggedError<ShellCompositionUnavailableError>()(
  'ShellCompositionUnavailableError',
  {},
) {}

export interface ShellCompositionContext {
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface ShellNavigationItem {
  readonly appId: string;
  readonly enabled: boolean;
  readonly groupKey: string;
  readonly href?: string;
  readonly label: string;
  readonly moduleId: string;
  readonly order: number;
  readonly state: Extract<TenantModuleState, 'active' | 'deprecated' | 'read_only'>;
  readonly unavailable: boolean;
  readonly writable: boolean;
}

export type ShellCompositionModel =
  | { readonly navigation: readonly []; readonly state: 'selection_required' }
  | { readonly navigation: readonly ShellNavigationItem[]; readonly state: 'available' };

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

export interface ShellCompositionDependencies {
  readonly catalog: Effect.Effect<InstalledModuleCatalog, unknown>;
  readonly contextAccess: ContextAccessService;
  readonly moduleStates: Pick<TenantModuleStateServiceContract, 'getTenantModuleStates'>;
}

const isVisibleState = (state: TenantModuleState): state is ShellNavigationItem['state'] =>
  state === 'active' || state === 'deprecated' || state === 'read_only';

const loadCatalog = (
  dependencies: ShellCompositionDependencies,
): Effect.Effect<InstalledModuleCatalog, ShellCompositionUnavailableError> =>
  dependencies.catalog.pipe(Effect.mapError(() => new ShellCompositionUnavailableError()));

const loadStates = (
  dependencies: ShellCompositionDependencies,
  context: ShellCompositionContext,
  moduleIds: readonly string[],
) =>
  dependencies.moduleStates
    .getTenantModuleStates(context.tenantId, moduleIds)
    .pipe(Effect.mapError(() => new ShellCompositionUnavailableError()));

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

export const makeShellComposition = (dependencies: ShellCompositionDependencies) => {
  const compose = (
    context: ShellCompositionContext,
  ): Effect.Effect<ShellCompositionModel, ShellCompositionUnavailableError> =>
    Effect.gen(function* composeShellEffect() {
      if (context.legalEntityId === undefined) {
        return { navigation: [], state: 'selection_required' } as const;
      }
      const catalog = yield* loadCatalog(dependencies);
      const { moduleIds } = catalog;
      const records = yield* loadStates(dependencies, context, moduleIds);
      const states = new Map(records.map(({ moduleKey, state }) => [moduleKey, state]));
      const decisions = yield* dependencies.contextAccess.modules({
        legalEntityId: context.legalEntityId,
        moduleIds,
        principalId: context.principalId,
        tenantId: context.tenantId,
      });
      if (
        decisions.length !== moduleIds.length ||
        decisions.some(({ key }, index) => key !== moduleIds[index])
      ) {
        return yield* new ShellCompositionUnavailableError();
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
        return contract.manifest.publicSurface.shellContributions.navigation.map(
          (contribution): ShellNavigationItem => {
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
          },
        );
      });
      return {
        navigation: navigation.toSorted(
          (left, right) =>
            left.order - right.order ||
            left.label.localeCompare(right.label) ||
            left.moduleId.localeCompare(right.moduleId),
        ),
        state: 'available',
      } as const;
    });

  const resolveModuleTarget = (
    context: ShellCompositionContext,
    input: {
      readonly access?: ModuleEntrypointAccess;
      readonly entrypointKey?: string;
      readonly moduleId: string;
    },
  ): Effect.Effect<ShellTargetResolution, ShellCompositionUnavailableError> =>
    Effect.gen(function* resolveModuleTargetEffect() {
      if (context.legalEntityId === undefined) {
        return { outcome: 'selection_required' } as const;
      }
      const catalog = yield* loadCatalog(dependencies);
      const contract = catalog.getByModuleId(input.moduleId);
      if (contract === undefined) {
        return { outcome: 'not_found' } as const;
      }
      const { pages } = contract.manifest.publicSurface.shellContributions;
      const { navigation } = contract.manifest.publicSurface.shellContributions;
      const landing = navigation[0];
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
          : pages.find(({ contributionKey }) => contributionKey === landing.pageKey);
      const page = input.entrypointKey === undefined ? landingPage : exactPage;
      if (page === undefined) {
        return { outcome: 'not_found' } as const;
      }
      const records = yield* loadStates(dependencies, context, [input.moduleId]);
      const state = records[0]?.moduleKey === input.moduleId ? records[0].state : undefined;
      if (state === undefined) {
        return { outcome: 'not_found' } as const;
      }
      const access = input.access ?? page.entrypoint.access;
      if (decideModuleStateAccess(state, access) === 'deny') {
        return { outcome: 'not_found' } as const;
      }
      const [permission, ...unexpected] = yield* dependencies.contextAccess.modules({
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
    });

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
