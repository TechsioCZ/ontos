// @effect-diagnostics asyncFunction:off
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthContextResponse, DemoUserKey, SetModuleStatePayload } from '../effect/auth-api';
import {
  getShellAuthContext,
  runEffectRequest,
  setShellModuleState,
  signInShellAuth,
  signOutShellAuth,
} from '../effect/auth-client';

interface ShellAuthState {
  readonly context: AuthContextResponse['context'];
  readonly isPending: boolean;
  readonly refresh: () => Promise<void>;
  readonly setModuleState: (payload: SetModuleStatePayload) => Promise<void>;
  readonly signIn: (demoUserKey: DemoUserKey) => Promise<void>;
  readonly signOut: () => Promise<void>;
}

const ShellAuthContext = createContext<ShellAuthState | undefined>(undefined);

export const ShellAuthProvider = ({ children }: { readonly children: ReactNode }) => {
  const [context, setContext] = useState<AuthContextResponse['context']>(null);
  const [isPending, setIsPending] = useState(false);

  const refresh = useCallback(async () => {
    const result = await runEffectRequest(getShellAuthContext());
    setContext(result.context);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runPending = useCallback(async (task: () => Promise<AuthContextResponse>) => {
    setIsPending(true);
    try {
      const result = await task();
      setContext(result.context);
    } finally {
      setIsPending(false);
    }
  }, []);

  const value = useMemo<ShellAuthState>(
    () => ({
      context,
      isPending,
      refresh,
      setModuleState: (payload) => runPending(() => runEffectRequest(setShellModuleState(payload))),
      signIn: (demoUserKey) => runPending(() => runEffectRequest(signInShellAuth(demoUserKey))),
      signOut: () => runPending(() => runEffectRequest(signOutShellAuth())),
    }),
    [context, isPending, refresh, runPending],
  );

  return <ShellAuthContext.Provider value={value}>{children}</ShellAuthContext.Provider>;
};

export const useShellAuth = () => {
  const value = useContext(ShellAuthContext);

  if (value === undefined) {
    throw new Error('useShellAuth must be used inside ShellAuthProvider.');
  }

  return value;
};
