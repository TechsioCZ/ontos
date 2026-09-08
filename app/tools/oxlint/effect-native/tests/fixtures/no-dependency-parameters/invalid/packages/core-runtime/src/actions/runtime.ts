// expect-count: 8
import { Effect, Layer } from "effect";

interface ActionRepositoryService {
  readonly load: (id: string) => Effect.Effect<string>;
}
interface ActionPermissionService {
  readonly allows: (id: string) => Effect.Effect<boolean>;
}
interface OperationalScopeResolverService {
  readonly resolve: () => Effect.Effect<string>;
}
declare const CoreDatabaseService: { readonly Service: { readonly query: () => Effect.Effect<string> } };
declare const ContextAccess: { readonly Service: { readonly read: () => Effect.Effect<string> } };

export interface ActionRuntimeOptions {
  readonly onStage?: (stage: string) => void;
  readonly contextAccess?: (typeof ContextAccess)["Service"];
}

// 1-5: five positional dependencies, the B4 evidence signature.
export const makeActionRuntime = (
  database: (typeof CoreDatabaseService)["Service"],
  repository: ActionRepositoryService,
  permission: ActionPermissionService,
  operationalScopeResolver: OperationalScopeResolverService,
  options: ActionRuntimeOptions,
) => ({ database, repository, permission, operationalScopeResolver, options });

// 6: union with `undefined` still injects the service.
export function installScope(contextAccess: (typeof ContextAccess)["Service"] | undefined) {
  return contextAccess;
}

// 7: a default value does not make it a configuration value.
export const makeReadRuntime = (
  repository: ActionRepositoryService = {} as ActionRepositoryService,
) => repository;

// 8: type-level port declaration.
export interface RuntimeFactory {
  readonly build: (permission: ActionPermissionService) => Effect.Effect<never>;
}

// Return types are how a Live layer is built: not reported.
export declare const actionRuntimeLive: Layer.Layer<never>;
export const buildRepository = (): ActionRepositoryService => ({ load: () => Effect.succeed("") });
