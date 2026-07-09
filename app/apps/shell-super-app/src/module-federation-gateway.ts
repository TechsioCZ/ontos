// @effect-diagnostics asyncFunction:off
import { loadRemote } from '@module-federation/modern-js-v3/runtime';
import { loadModuleEntrypoint, ModuleEntrypointDeniedError } from './module-entrypoint-gateway';
import { loadShellModuleStates } from './shell-operation-context-client';
import type { ShellModuleEntrypoint } from './module-entrypoints';

export const loadShellModuleFederationEntrypoint = async <TModule>(
  entrypoint: ShellModuleEntrypoint,
): Promise<TModule> => {
  const result = await loadModuleEntrypoint({
    entrypoint,
    loader: (specifier) => loadRemote<TModule>(specifier) as Promise<TModule>,
    moduleStates: await loadShellModuleStates(),
  });

  if (result._tag === 'ModuleEntrypointDenied') {
    throw new ModuleEntrypointDeniedError(result);
  }

  return result.module;
};
