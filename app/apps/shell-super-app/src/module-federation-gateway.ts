// @effect-diagnostics asyncFunction:off globalFetch:off
import { loadRemote } from '@module-federation/modern-js-v3/runtime';
import type { TenantModuleState } from '@app/shared-contracts';
import { loadModuleEntrypoint, ModuleEntrypointDeniedError } from './module-entrypoint-gateway';
import type { ShellModuleEntrypoint } from './module-entrypoints';

interface ShellOperationContextResponse {
  readonly moduleStates?: readonly TenantModuleState[];
}

export class ShellOperationContextAuthRequiredError extends Error {
  constructor() {
    super('Authentication is required to load shell module entrypoints.');
    this.name = 'ShellOperationContextAuthRequiredError';
  }
}

export const isShellOperationContextAuthRequiredError = (
  error: unknown,
): error is ShellOperationContextAuthRequiredError =>
  error instanceof ShellOperationContextAuthRequiredError ||
  (error instanceof Error && error.name === 'ShellOperationContextAuthRequiredError');

const shellOperationContextUnavailableError = (status: number) =>
  Object.assign(new Error(`Shell operation context request failed with status ${status}.`), {
    name: 'ShellOperationContextUnavailableError',
    status,
  });

export const loadShellModuleStates = async () => {
  const response = await fetch('/shell-super-app-api/operation-context', {
    credentials: 'same-origin',
  });

  if (response.status === 401) {
    throw new ShellOperationContextAuthRequiredError();
  }

  if (!response.ok) {
    throw shellOperationContextUnavailableError(response.status);
  }

  const body = (await response.json()) as ShellOperationContextResponse;
  return body.moduleStates ?? [];
};

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
