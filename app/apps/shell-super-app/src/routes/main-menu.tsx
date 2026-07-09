import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import type { ActiveTenantModuleState, PrincipalDisplayUser } from './use-principal';

interface MainMenuProps {
  readonly activeModules: readonly ActiveTenantModuleState[];
  readonly onLogout: () => void;
  readonly user: PrincipalDisplayUser;
}

const supportedLanguages = new Set(['en', 'cs']);

const normalizeLanguage = (language: string) =>
  supportedLanguages.has(language) ? language : 'en';

const moduleLabel = (moduleKey: string) =>
  moduleKey
    .split(/[-_.]/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');

export const MainMenu = ({ activeModules, onLogout, user }: MainMenuProps) => {
  const { language, t } = useModernI18n();
  const lang = normalizeLanguage(language);

  return (
    <nav
      aria-label={t('mainMenu.label')}
      className="w-full max-w-sm border border-[var(--ui-color-border)] bg-[var(--ui-color-bg-surface)] p-4 shadow-sm"
      data-testid="main-menu"
    >
      <div className="border-b border-[var(--ui-color-border)] pb-4">
        <p className="truncate text-base font-medium text-[var(--ui-color-text-strong)]">
          {user.name}
        </p>
        <p className="truncate text-sm text-[var(--ui-color-text-muted)]">{user.email}</p>
      </div>

      <div className="py-3">
        <p className="px-2 pb-2 text-xs font-semibold uppercase tracking-normal text-[var(--ui-color-text-muted)]">
          {t('mainMenu.modules')}
        </p>
        <ul className="flex flex-col gap-1">
          {activeModules.map((moduleState) => (
            <li key={moduleState.moduleKey}>
              <Link
                className="flex min-h-10 items-center px-2 text-sm font-medium text-[var(--ui-color-text)] no-underline hover:bg-[var(--ui-color-bg-canvas)]"
                href={`/${lang}/${moduleState.moduleKey}`}
              >
                {moduleLabel(moduleState.moduleKey)}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <div className="pt-1">
        <Button type="button" variant="secondary" theme="outlined" onClick={onLogout}>
          {t('auth.logout')}
        </Button>
      </div>
    </nav>
  );
};
