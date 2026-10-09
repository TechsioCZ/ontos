import { useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import type { ReactElement } from 'react';

import { ultramodernUiMarker } from '../../ultramodern-build';
import { UltramodernRouteHead } from '../ultramodern-route-head';

const CommerceMarketCatalogHome = (): ReactElement => {
  const { language, supportedLanguages, t } = useModernI18n();

  return (
    <main className="commercemarketcatalog:min-h-screen commercemarketcatalog:bg-um-canvas commercemarketcatalog:px-4 commercemarketcatalog:py-6 commercemarketcatalog:text-um-foreground commercemarketcatalog:sm:px-8">
      <UltramodernRouteHead />
      <nav
        aria-label={t('commerce-market-catalog.language.switcher')}
        className="commercemarketcatalog:flex commercemarketcatalog:gap-3"
      >
        {supportedLanguages.map((code) => (
          <Link
            aria-current={language === code ? 'page' : undefined}
            className="commercemarketcatalog:rounded-full commercemarketcatalog:border commercemarketcatalog:border-stone-900/15 commercemarketcatalog:bg-white commercemarketcatalog:px-4 commercemarketcatalog:py-2 commercemarketcatalog:text-sm commercemarketcatalog:font-bold commercemarketcatalog:text-stone-950 commercemarketcatalog:no-underline"
            key={code}
            params={{ lang: code }}
            to="/$lang"
          >
            {t(`commerce-market-catalog.language.${code}`)}
          </Link>
        ))}
      </nav>
      <h1 className="commercemarketcatalog:mt-10 commercemarketcatalog:text-5xl commercemarketcatalog:font-black">
        {t('commerce-market-catalog.title')}
      </h1>
      <p
        className="commercemarketcatalog:mt-3 commercemarketcatalog:text-lg commercemarketcatalog:text-stone-600"
        data-modern-mf-role="vertical"
      >
        {t('commerce-market-catalog.role')}
      </p>
      <p
        className="commercemarketcatalog:sr-only"
        data-build-marker={ultramodernUiMarker.build}
        data-testid="ultramodern-ui-marker"
      >
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
    </main>
  );
};

export default CommerceMarketCatalogHome;
