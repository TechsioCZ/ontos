// @effect-diagnostics asyncFunction:off
import { moduleActivationStates } from '@mvp2/shared-contracts';
import { useState } from 'react';
import type { InstalledModuleKey, ModuleActivationState } from '@mvp2/shared-contracts';
import { useShellAuth } from './shell-auth-context';

export const ModuleStateAdminPanel = () => {
  const { context, isPending, setModuleState } = useShellAuth();
  const [pendingModule, setPendingModule] = useState<InstalledModuleKey | null>(null);

  if (context === null || !context.moduleStateAdmin.canChange) {
    return null;
  }

  const changeState = async (moduleKey: InstalledModuleKey, state: ModuleActivationState) => {
    setPendingModule(moduleKey);
    try {
      await setModuleState({
        moduleKey,
        reason: 'Changed from Shell module-state admin UI.',
        state,
      });
    } finally {
      setPendingModule(null);
    }
  };

  return (
    <section className="shell:mt-4 shell:max-w-2xl shell:bg-white/90 shell:p-4 shell:shadow-lg shell:shadow-stone-900/10">
      <div className="shell:grid shell:gap-2 shell:sm:grid-cols-2">
        {context.moduleStates.map((moduleState) => (
          <label
            className="shell:flex shell:min-w-0 shell:items-center shell:justify-between shell:gap-2 shell:border shell:border-stone-900/10 shell:bg-white shell:p-3"
            key={moduleState.moduleKey}
          >
            <span className="shell:min-w-0">
              <span className="shell:block shell:text-sm shell:font-black shell:text-stone-950">
                {moduleState.moduleKey}
              </span>
              <span className="shell:block shell:text-xs shell:font-semibold shell:text-stone-600">
                {moduleState.state}
              </span>
            </span>
            <select
              className="shell:min-h-9 shell:min-w-28 shell:border shell:border-stone-900/15 shell:bg-white shell:px-2 shell:text-sm shell:font-bold shell:text-stone-950 shell:disabled:cursor-not-allowed shell:disabled:opacity-60"
              disabled={isPending || pendingModule === moduleState.moduleKey}
              onChange={(event) =>
                void changeState(
                  moduleState.moduleKey,
                  event.currentTarget.value as ModuleActivationState,
                )
              }
              value={moduleState.state}
            >
              {moduleActivationStates.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </section>
  );
};
