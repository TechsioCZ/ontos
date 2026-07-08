import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { authClient } from '../../auth/auth-client';
import { ultramodernUiMarker } from '../../ultramodern-build';

const supportedLanguages = new Set(['en', 'cs']);
type Language = 'en' | 'cs';

const normalizeLanguage = (language: string): Language =>
  supportedLanguages.has(language) ? (language as Language) : 'en';

export default function ShellHome() {
  const { language, t } = useModernI18n();
  const session = authClient.useSession();
  const user = session.data?.user;
  const lang = normalizeLanguage(language);

  const handleLogout = () => {
    void authClient.signOut();
  };

  return (
    <main className="min-h-screen bg-[var(--ui-color-bg-canvas)] text-[var(--ui-color-text)]">
      <section className="mx-auto flex min-h-screen w-full max-w-5xl flex-col justify-center px-6 py-12">
        <div className="max-w-2xl space-y-8">
          <div className="space-y-3">
            <p className="text-sm font-medium uppercase tracking-normal text-[var(--ui-color-text-muted)]">
              {t('home.eyebrow')}
            </p>
            <h1 className="text-4xl font-semibold tracking-normal text-[var(--ui-color-text-strong)] md:text-5xl">
              {t('home.title')}
            </h1>
          </div>

          <div className="border-y border-[var(--ui-color-border)] py-6">
            {user !== undefined && user !== null ? (
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-base font-medium text-[var(--ui-color-text-strong)]">
                    {user.name}
                  </p>
                  <p className="truncate text-sm text-[var(--ui-color-text-muted)]">{user.email}</p>
                </div>
                <Button type="button" variant="secondary" theme="outlined" onClick={handleLogout}>
                  {t('auth.logout')}
                </Button>
              </div>
            ) : (
              <Link href={`/${lang}/login`}>{t('auth.loginLink')}</Link>
            )}
          </div>
        </div>
      </section>
      <p className="sr-only" data-testid="ultramodern-preset">
        presetUltramodern workspace
      </p>
      <p
        className="sr-only"
        data-build-marker={ultramodernUiMarker.build}
        data-testid="ultramodern-ui-marker"
      >
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
    </main>
  );
}
