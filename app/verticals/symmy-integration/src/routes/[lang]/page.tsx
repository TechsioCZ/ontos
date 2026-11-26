import { useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { ultramodernUiMarker } from '../../ultramodern-build';
import { UltramodernRouteHead } from '../ultramodern-route-head';

const SymmyIntegrationHome = () => {
  const { language, supportedLanguages, t } = useModernI18n();

  return (
    <main className="symmyintegration:min-h-screen symmyintegration:bg-um-canvas symmyintegration:px-4 symmyintegration:py-6 symmyintegration:text-um-foreground symmyintegration:sm:px-8">
      <UltramodernRouteHead />
      <nav
        aria-label={t('symmy-integration.language.switcher')}
        className="symmyintegration:flex symmyintegration:gap-3"
      >
        {supportedLanguages.map((code) => (
          <Link
            aria-current={language === code ? 'page' : undefined}
            className="symmyintegration:rounded-full symmyintegration:border symmyintegration:border-stone-900/15 symmyintegration:bg-white symmyintegration:px-4 symmyintegration:py-2 symmyintegration:text-sm symmyintegration:font-bold symmyintegration:text-stone-950 symmyintegration:no-underline"
            key={code}
            params={{ lang: code }}
            to="/$lang/"
          >
            {t(`symmy-integration.language.${code}`)}
          </Link>
        ))}
      </nav>
      <h1 className="symmyintegration:mt-10 symmyintegration:text-5xl symmyintegration:font-black">
        {t('symmy-integration.title')}
      </h1>
      <p
        className="symmyintegration:mt-3 symmyintegration:text-lg symmyintegration:text-stone-600"
        data-modern-mf-role="vertical"
      >
        {t('symmy-integration.role')}
      </p>
      <p
        className="symmyintegration:sr-only"
        data-build-marker={ultramodernUiMarker.build}
        data-testid="ultramodern-ui-marker"
      >
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
    </main>
  );
};

export default SymmyIntegrationHome;
