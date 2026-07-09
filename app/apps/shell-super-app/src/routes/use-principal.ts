// @effect-diagnostics asyncFunction:off
import type { TenantModuleState } from '@app/shared-contracts';
import { useEffect, useState } from 'react';
import { authClient } from '../auth/auth-client';
import {
  isShellOperationContextAuthRequiredError,
  loadShellOperationContext,
} from '../shell-operation-context-client';

export type ActiveTenantModuleState = TenantModuleState & { readonly state: 'active' };

export interface PrincipalDisplayUser {
  readonly email: string;
  readonly name: string;
}

export type PrincipalState =
  | { readonly status: 'loading' }
  | { readonly status: 'unauthenticated' }
  | { readonly error: Error; readonly status: 'error' }
  | {
      readonly activeModules: readonly ActiveTenantModuleState[];
      readonly legalEntityId: string;
      readonly principalId: string;
      readonly status: 'ready';
      readonly tenantId: string;
      readonly user: PrincipalDisplayUser;
    };

interface BetterAuthDisplayUser {
  readonly email?: string | null;
  readonly name?: string | null;
}

const isActiveTenantModuleState = (
  moduleState: TenantModuleState,
): moduleState is ActiveTenantModuleState => moduleState.state === 'active';

const toDisplayUser = (user: BetterAuthDisplayUser): PrincipalDisplayUser | null => {
  if (user.email === undefined || user.email === null || user.email.trim().length === 0) {
    return null;
  }

  const trimmedName = user.name?.trim();

  return {
    email: user.email,
    name: trimmedName === undefined || trimmedName.length === 0 ? user.email : trimmedName,
  };
};

export const usePrincipal = (): PrincipalState => {
  const session = authClient.useSession();
  const user = session.data?.user;
  const [principalState, setPrincipalState] = useState<PrincipalState>({ status: 'loading' });

  useEffect(() => {
    const displayUser =
      user === undefined || user === null ? null : toDisplayUser(user as BetterAuthDisplayUser);

    if (displayUser === null) {
      setPrincipalState({ status: 'unauthenticated' });
      return;
    }

    let cancelled = false;

    const loadPrincipal = async () => {
      setPrincipalState({ status: 'loading' });

      try {
        const context = await loadShellOperationContext();

        if (!cancelled) {
          setPrincipalState({
            activeModules: context.moduleStates.filter(isActiveTenantModuleState),
            legalEntityId: context.operationContext.legalEntityId,
            principalId: context.operationContext.principalId,
            status: 'ready',
            tenantId: context.operationContext.tenantId,
            user: displayUser,
          });
        }
      } catch (caughtError) {
        if (cancelled) {
          return;
        }

        if (isShellOperationContextAuthRequiredError(caughtError)) {
          setPrincipalState({ status: 'unauthenticated' });
          return;
        }

        setPrincipalState({
          error: caughtError instanceof Error ? caughtError : new Error(String(caughtError)),
          status: 'error',
        });
      }
    };

    void loadPrincipal();

    return () => {
      cancelled = true;
    };
  }, [user]);

  return principalState;
};
