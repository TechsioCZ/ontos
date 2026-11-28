import { useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { ultramodernUiMarker } from '../../ultramodern-build';
import { UltramodernRouteHead } from '../ultramodern-route-head';

const SymmyIntegrationHome = () => {
  const { language, supportedLanguages, t } = useModernI18n();

  return (
    <main className="min-h-screen bg-base px-4 py-6 text-fg-primary sm:px-8">
      <UltramodernRouteHead />
      <nav aria-label={t('symmy-integration.language.switcher')} className="flex gap-3">
        {supportedLanguages.map((code) => (
          <Link
            aria-current={language === code ? 'page' : undefined}
            className="rounded-full border border-border-primary bg-surface px-4 py-2 text-sm font-bold text-fg-primary no-underline"
            key={code}
            params={{ lang: code }}
            to="/$lang"
          >
            {t(`symmy-integration.language.${code}`)}
          </Link>
        ))}
      </nav>
      <h1 className="mt-10 text-4xl font-bold">{t('symmy-integration.title')}</h1>
      <p className="mt-3 text-lg text-fg-secondary" data-modern-mf-role="vertical">
        {t('symmy-integration.role')}
      </p>
      <p className="sr-only" data-build-marker={ultramodernUiMarker.build} data-testid="ultramodern-ui-marker">
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
    </main>
  );
};

export default SymmyIntegrationHome;
