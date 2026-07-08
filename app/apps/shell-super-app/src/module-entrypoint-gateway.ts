// @effect-diagnostics asyncFunction:off extendsNativeError:off
import { isModuleStateAccessAllowed } from '@app/shared-contracts';
import type { ModuleActivationState, TenantModuleState } from '@app/shared-contracts';
import type { ShellModuleEntrypoint } from './module-entrypoints';

export interface ModuleEntrypointDenied {
  readonly _tag: 'ModuleEntrypointDenied';
  readonly accessKind: ShellModuleEntrypoint['accessKind'];
  readonly entrypointId: string;
  readonly moduleKey: ShellModuleEntrypoint['moduleKey'];
  readonly state: ModuleActivationState;
}

export interface ModuleEntrypointLoaded<TModule> {
  readonly _tag: 'ModuleEntrypointLoaded';
  readonly module: TModule;
}

export type ModuleEntrypointLoadResult<TModule> =
  | ModuleEntrypointDenied
  | ModuleEntrypointLoaded<TModule>;

export class ModuleEntrypointDeniedError extends Error {
  readonly decision: ModuleEntrypointDenied;

  constructor(decision: ModuleEntrypointDenied) {
    super(`Module entrypoint "${decision.entrypointId}" is denied for state "${decision.state}".`);
    this.name = 'ModuleEntrypointDeniedError';
    this.decision = decision;
  }
}

export const resolveModuleEntrypointState = ({
  entrypoint,
  moduleStates,
}: {
  readonly entrypoint: ShellModuleEntrypoint;
  readonly moduleStates: readonly TenantModuleState[];
}): ModuleActivationState =>
  moduleStates.find((moduleState) => moduleState.moduleKey === entrypoint.moduleKey)?.state ??
  'inactive';

export const loadModuleEntrypoint = async <TModule>({
  entrypoint,
  loader,
  moduleStates,
}: {
  readonly entrypoint: ShellModuleEntrypoint;
  readonly loader: (remoteSpecifier: string) => Promise<TModule>;
  readonly moduleStates: readonly TenantModuleState[];
}): Promise<ModuleEntrypointLoadResult<TModule>> => {
  const state = resolveModuleEntrypointState({ entrypoint, moduleStates });

  if (!isModuleStateAccessAllowed({ accessKind: entrypoint.accessKind, state })) {
    return {
      _tag: 'ModuleEntrypointDenied',
      accessKind: entrypoint.accessKind,
      entrypointId: entrypoint.id,
      moduleKey: entrypoint.moduleKey,
      state,
    };
  }

  return {
    _tag: 'ModuleEntrypointLoaded',
    module: await loader(entrypoint.remoteSpecifier),
  };
};
