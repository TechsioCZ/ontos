// @effect-diagnostics asyncFunction:off extendsNativeError:off globalFetch:off
import type { TenantModuleState } from '@app/shared-contracts';

export interface ShellOperationContextIdentity {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface ShellOperationContext {
  readonly moduleStates: readonly TenantModuleState[];
  readonly operationContext: ShellOperationContextIdentity;
}

interface ShellOperationContextResponse {
  readonly moduleStates?: readonly TenantModuleState[];
  readonly operationContext?: ShellOperationContextIdentity;
}

export class ShellOperationContextAuthRequiredError extends Error {
  constructor() {
    super('Authentication is required to load shell operation context.');
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

const isShellOperationContextIdentity = (
  value: ShellOperationContextResponse['operationContext'],
): value is ShellOperationContextIdentity =>
  value !== undefined &&
  typeof value.legalEntityId === 'string' &&
  typeof value.principalId === 'string' &&
  typeof value.tenantId === 'string';

export const loadShellOperationContext = async (): Promise<ShellOperationContext> => {
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
  if (!isShellOperationContextIdentity(body.operationContext)) {
    throw Object.assign(new Error('Shell operation context response is missing identity.'), {
      name: 'ShellOperationContextUnavailableError',
      status: response.status,
    });
  }

  return {
    moduleStates: body.moduleStates ?? [],
    operationContext: body.operationContext,
  };
};

export const loadShellModuleStates = async () => {
  const context = await loadShellOperationContext();
  return context.moduleStates;
};
