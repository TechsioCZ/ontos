// @effect-diagnostics asyncFunction:off
import type { TenantModuleState } from '@app/shared-contracts';
import { useEffect, useState } from 'react';
import { authClient } from '../auth/auth-client';
import {
  isShellOperationContextAuthRequiredError,
  loadShellOperationContext,
} from '../shell-operation-context-client';
import type { ShellOperationContextIdentity } from '../shell-operation-context-client';

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
      readonly operationContext: ShellOperationContextIdentity;
      readonly status: 'ready';
      readonly user: PrincipalDisplayUser;
    };

interface BetterAuthDisplayUser {
  readonly email?: string | null;
  readonly name?: string | null;
}

const isActiveTenantModuleState = (
  moduleState: TenantModuleState,
): moduleState is ActiveTenantModuleState => moduleState.state === 'active';

const resolveDisplayName = ({
  email,
  principalDisplayName,
  userName,
}: {
  readonly email: string;
  readonly principalDisplayName?: string | undefined;
  readonly userName?: string | null | undefined;
}) => {
  const trimmedPrincipalDisplayName = principalDisplayName?.trim();
  if (trimmedPrincipalDisplayName !== undefined && trimmedPrincipalDisplayName.length > 0) {
    return trimmedPrincipalDisplayName;
  }

  const trimmedName = userName?.trim();
  if (trimmedName !== undefined && trimmedName.length > 0) {
    return trimmedName;
  }

  return email;
};

const toDisplayUser = ({
  principalDisplayName,
  user,
}: {
  readonly principalDisplayName?: string;
  readonly user: BetterAuthDisplayUser;
}): PrincipalDisplayUser | null => {
  if (user.email === undefined || user.email === null || user.email.trim().length === 0) {
    return null;
  }

  return {
    email: user.email,
    name: resolveDisplayName({
      email: user.email,
      principalDisplayName,
      userName: user.name,
    }),
  };
};

export const usePrincipal = (): PrincipalState => {
  const session = authClient.useSession();
  const user = session.data?.user;
  const [principalState, setPrincipalState] = useState<PrincipalState>({ status: 'loading' });

  useEffect(() => {
    if (user === undefined || user === null) {
      setPrincipalState({ status: 'unauthenticated' });
      return;
    }

    let cancelled = false;

    const loadPrincipal = async () => {
      setPrincipalState({ status: 'loading' });

      try {
        const context = await loadShellOperationContext();

        if (cancelled) {
          return;
        }

        const displayUser = toDisplayUser({
          principalDisplayName: context.operationContext.principalDisplayName,
          user: user as BetterAuthDisplayUser,
        });

        if (displayUser === null) {
          setPrincipalState({ status: 'unauthenticated' });
          return;
        }

        if (!cancelled) {
          setPrincipalState({
            activeModules: context.moduleStates.filter(isActiveTenantModuleState),
            operationContext: context.operationContext,
            status: 'ready',
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
