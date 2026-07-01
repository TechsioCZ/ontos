import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { DemoUserKey } from '../effect/auth-api';
import { useShellAuth } from './shell-auth-context';

interface SignInOption {
  readonly className: string;
  readonly labelKey: string;
  readonly userKey: DemoUserKey;
}

const signInOptions: readonly SignInOption[] = [
  {
    className:
      'shell:inline-flex shell:min-h-11 shell:items-center shell:justify-center shell:rounded-full shell:bg-stone-950 shell:px-5 shell:font-bold shell:text-white shell:shadow-lg shell:shadow-stone-900/10 shell:disabled:cursor-not-allowed shell:disabled:opacity-60',
    labelKey: 'shell.auth.profiles.admin',
    userKey: 'admin',
  },
  {
    className:
      'shell:inline-flex shell:min-h-11 shell:items-center shell:justify-center shell:rounded-full shell:bg-emerald-800 shell:px-5 shell:font-bold shell:text-white shell:shadow-lg shell:shadow-stone-900/10 shell:disabled:cursor-not-allowed shell:disabled:opacity-60',
    labelKey: 'shell.auth.profiles.user',
    userKey: 'user',
  },
];

export const AuthControls = () => {
  const { i18nInstance } = useModernI18n();
  const t = i18nInstance['t'].bind(i18nInstance);
  const { context: authContext, isPending, signIn, signOut } = useShellAuth();

  return (
    <div className="shell:mt-7 shell:flex shell:flex-col shell:gap-3">
      <div className="shell:flex shell:flex-wrap shell:gap-3">
        {signInOptions.map((option) => (
          <button
            className={option.className}
            disabled={isPending}
            key={option.userKey}
            onClick={() => void signIn(option.userKey)}
            type="button"
          >
            {t(option.labelKey)}
          </button>
        ))}
        <button
          className="shell:inline-flex shell:min-h-11 shell:items-center shell:justify-center shell:rounded-full shell:border shell:border-stone-900/15 shell:bg-white/90 shell:px-5 shell:font-bold shell:text-stone-950 shell:shadow-lg shell:shadow-stone-900/10 shell:disabled:cursor-not-allowed shell:disabled:opacity-60"
          disabled={isPending || authContext === null}
          onClick={() => void signOut()}
          type="button"
        >
          {t('shell.auth.signOut')}
        </button>
      </div>
      {authContext === null ? null : (
        <div className="shell:grid shell:max-w-2xl shell:gap-2 shell:rounded-2xl shell:bg-white/85 shell:p-4 shell:text-sm shell:shadow-lg shell:shadow-stone-900/10 shell:sm:grid-cols-3">
          <div>
            <div className="shell:text-xs shell:font-bold shell:uppercase shell:text-stone-500">
              {t('shell.auth.currentUser')}
            </div>
            <div className="shell:mt-1 shell:font-bold shell:text-stone-950">
              {authContext.user.name}
            </div>
            <div className="shell:break-all shell:text-stone-600">{authContext.user.email}</div>
          </div>
          <div>
            <div className="shell:text-xs shell:font-bold shell:uppercase shell:text-stone-500">
              {t('shell.auth.tenant')}
            </div>
            <div className="shell:mt-1 shell:font-bold shell:text-stone-950">
              {authContext.tenant.name}
            </div>
          </div>
          <div>
            <div className="shell:text-xs shell:font-bold shell:uppercase shell:text-stone-500">
              {t('shell.auth.legalEntity')}
            </div>
            <div className="shell:mt-1 shell:font-bold shell:text-stone-950">
              {authContext.legalEntity.name}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
