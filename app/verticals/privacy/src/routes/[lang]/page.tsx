import { useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { ultramodernUiMarker } from '../../ultramodern-build';
import { UltramodernRouteHead } from '../ultramodern-route-head';

const PrivacyHome = () => {
  const { language, supportedLanguages, t } = useModernI18n();

  return (
    <main className="privacy:min-h-screen privacy:bg-um-canvas privacy:px-4 privacy:py-6 privacy:text-um-foreground privacy:sm:px-8">
      <UltramodernRouteHead />
      <nav aria-label={t('privacy.language.switcher')} className="privacy:flex privacy:gap-3">
        {supportedLanguages.map((code) => (
          <Link
            aria-current={language === code ? 'page' : undefined}
            className="privacy:rounded-full privacy:border privacy:border-stone-900/15 privacy:bg-white privacy:px-4 privacy:py-2 privacy:text-sm privacy:font-bold privacy:text-stone-950 privacy:no-underline"
            key={code}
            params={{ lang: code }}
            to="/$lang"
          >
            {t(`privacy.language.${code}`)}
          </Link>
        ))}
      </nav>
      <h1 className="privacy:mt-10 privacy:text-5xl privacy:font-black">{t('privacy.title')}</h1>
      <p className="privacy:mt-3 privacy:text-lg privacy:text-stone-600" data-modern-mf-role="vertical">
        {t('privacy.role')}
      </p>
      <p className="privacy:sr-only" data-build-marker={ultramodernUiMarker.build} data-testid="ultramodern-ui-marker">
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
    </main>
  );
};

export default PrivacyHome;
