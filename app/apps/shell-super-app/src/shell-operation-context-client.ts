// @effect-diagnostics asyncFunction:off extendsNativeError:off globalFetch:off
import type { TenantModuleState } from '@app/shared-contracts';

export interface ShellOperationContextIdentity {
  readonly legalEntityId: string;
  readonly principalDisplayName: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface ShellOperationContext {
  readonly moduleStates: readonly TenantModuleState[];
  readonly operationContext: ShellOperationContextIdentity;
  readonly verticalGatewayTokens: Readonly<Record<string, string>>;
}

interface ShellOperationContextResponse {
  readonly moduleStates?: readonly TenantModuleState[];
  readonly operationContext?: ShellOperationContextIdentity;
  readonly verticalGatewayTokens?: Readonly<Record<string, string>>;
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

const loadShellOperationContextResponse = async (): Promise<ShellOperationContextResponse> => {
  const response = await fetch('/shell-super-app-api/operation-context', {
    credentials: 'same-origin',
  });

  if (response.status === 401) {
    throw new ShellOperationContextAuthRequiredError();
  }

  if (!response.ok) {
    throw shellOperationContextUnavailableError(response.status);
  }

  return (await response.json()) as ShellOperationContextResponse;
};

const isShellOperationContextIdentity = (
  value: ShellOperationContextResponse['operationContext'],
): value is ShellOperationContextIdentity =>
  value !== undefined &&
  typeof value.legalEntityId === 'string' &&
  typeof value.principalDisplayName === 'string' &&
  typeof value.principalId === 'string' &&
  typeof value.tenantId === 'string';

export const loadShellOperationContext = async (): Promise<ShellOperationContext> => {
  const body = await loadShellOperationContextResponse();
  if (!isShellOperationContextIdentity(body.operationContext)) {
    throw Object.assign(new Error('Shell operation context response is missing identity.'), {
      name: 'ShellOperationContextUnavailableError',
      status: 200,
    });
  }

  return {
    moduleStates: body.moduleStates ?? [],
    operationContext: body.operationContext,
    verticalGatewayTokens: body.verticalGatewayTokens ?? {},
  };
};

export const loadShellModuleStates = async () => {
  const body = await loadShellOperationContextResponse();
  return body.moduleStates ?? [];
};
