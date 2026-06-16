// @effect-diagnostics asyncFunction:off
import { useEffect, useState } from 'react';
import type { AuthContextResponse, DemoUserKey } from '../effect/auth-api';
import {
  getShellAuthContext,
  runEffectRequest,
  signInShellAuth,
  signOutShellAuth,
} from '../effect/auth-client';

export function AuthControls() {
  const [authContext, setAuthContext] = useState<AuthContextResponse['context']>(null);
  const [isPending, setIsPending] = useState(false);

  useEffect(() => {
    void runEffectRequest(getShellAuthContext()).then((result) => setAuthContext(result.context));
  }, []);

  const signIn = async (demoUserKey: DemoUserKey) => {
    setIsPending(true);
    try {
      const result = await runEffectRequest(signInShellAuth(demoUserKey));
      setAuthContext(result.context);
    } finally {
      setIsPending(false);
    }
  };

  const signOut = async () => {
    setIsPending(true);
    try {
      const result = await runEffectRequest(signOutShellAuth());
      setAuthContext(result.context);
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="shell:mt-7 shell:flex shell:flex-col shell:gap-3">
      <div className="shell:flex shell:flex-wrap shell:gap-3">
        <button
          className="shell:inline-flex shell:min-h-11 shell:items-center shell:justify-center shell:rounded-full shell:bg-stone-950 shell:px-5 shell:font-bold shell:text-white shell:shadow-lg shell:shadow-stone-900/10 shell:disabled:cursor-not-allowed shell:disabled:opacity-60"
          disabled={isPending}
          onClick={() => void signIn('admin')}
          type="button"
        >
          Admin
        </button>
        <button
          className="shell:inline-flex shell:min-h-11 shell:items-center shell:justify-center shell:rounded-full shell:bg-emerald-800 shell:px-5 shell:font-bold shell:text-white shell:shadow-lg shell:shadow-stone-900/10 shell:disabled:cursor-not-allowed shell:disabled:opacity-60"
          disabled={isPending}
          onClick={() => void signIn('user')}
          type="button"
        >
          User
        </button>
        <button
          className="shell:inline-flex shell:min-h-11 shell:items-center shell:justify-center shell:rounded-full shell:border shell:border-stone-900/15 shell:bg-white/90 shell:px-5 shell:font-bold shell:text-stone-950 shell:shadow-lg shell:shadow-stone-900/10 shell:disabled:cursor-not-allowed shell:disabled:opacity-60"
          disabled={isPending || authContext === null}
          onClick={() => void signOut()}
          type="button"
        >
          Sign out
        </button>
      </div>
      {authContext === null ? null : (
        <div className="shell:grid shell:max-w-2xl shell:gap-2 shell:rounded-2xl shell:bg-white/85 shell:p-4 shell:text-sm shell:shadow-lg shell:shadow-stone-900/10 shell:sm:grid-cols-3">
          <div>
            <div className="shell:text-xs shell:font-bold shell:uppercase shell:text-stone-500">
              Logged user
            </div>
            <div className="shell:mt-1 shell:font-bold shell:text-stone-950">
              {authContext.user.name}
            </div>
            <div className="shell:break-all shell:text-stone-600">{authContext.user.email}</div>
          </div>
          <div>
            <div className="shell:text-xs shell:font-bold shell:uppercase shell:text-stone-500">
              Tenant
            </div>
            <div className="shell:mt-1 shell:font-bold shell:text-stone-950">
              {authContext.tenant.name}
            </div>
          </div>
          <div>
            <div className="shell:text-xs shell:font-bold shell:uppercase shell:text-stone-500">
              Legal entity
            </div>
            <div className="shell:mt-1 shell:font-bold shell:text-stone-950">
              {authContext.legalEntity.name}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
