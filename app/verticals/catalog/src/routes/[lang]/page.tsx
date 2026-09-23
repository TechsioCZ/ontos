import { useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import { Link } from '@modern-js/plugin-tanstack/runtime';

import { ultramodernUiMarker } from '../../ultramodern-build';
import { UltramodernRouteHead } from '../ultramodern-route-head';

const CatalogHome = () => {
  const { language, supportedLanguages, t } = useModernI18n();

  return (
    <main className="catalog:min-h-screen catalog:bg-um-canvas catalog:px-4 catalog:py-6 catalog:text-um-foreground catalog:sm:px-8">
      <UltramodernRouteHead />
      <nav aria-label={t('catalog.language.switcher')} className="catalog:flex catalog:gap-3">
        {supportedLanguages.map((code) => (
          <Link
            aria-current={language === code ? 'page' : undefined}
            className="catalog:rounded-full catalog:border catalog:border-stone-900/15 catalog:bg-white catalog:px-4 catalog:py-2 catalog:text-sm catalog:font-bold catalog:text-stone-950 catalog:no-underline"
            key={code}
            params={{ lang: code }}
            to="/$lang"
          >
            {t(`catalog.language.${code}`)}
          </Link>
        ))}
      </nav>
      <h1 className="catalog:mt-10 catalog:text-5xl catalog:font-black">{t('catalog.title')}</h1>
      <p className="catalog:mt-3 catalog:text-lg catalog:text-stone-600" data-modern-mf-role="vertical">
        {t('catalog.role')}
      </p>
      <p className="catalog:sr-only" data-build-marker={ultramodernUiMarker.build} data-testid="ultramodern-ui-marker">
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
      <p data-testid="catalog-foundation-status">{t('catalog.routeSurface')}</p>
    </main>
  );
};

export default CatalogHome;
