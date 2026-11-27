import { useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import type { ReactElement } from 'react';

import { ultramodernUiMarker } from '../../ultramodern-build';
import { UltramodernRouteHead } from '../ultramodern-route-head';

const CommerceMarketCatalogHome = (): ReactElement => {
  const { language, supportedLanguages, t } = useModernI18n();

  return (
    <main className="min-h-screen bg-base px-200 py-300 text-fg-primary sm:px-400">
      <UltramodernRouteHead />
      <nav aria-label={t('commerce-market-catalog.language.switcher')} className="flex gap-150">
        {supportedLanguages.map((code) => (
          <Link
            aria-current={language === code ? 'page' : undefined}
            className="rounded-full border border-border-primary bg-surface px-200 py-150 text-sm font-bold text-fg-primary no-underline"
            key={code}
            params={{ lang: code }}
            to="/$lang"
          >
            {t(`commerce-market-catalog.language.${code}`)}
          </Link>
        ))}
      </nav>
      <h1 className="mt-450 text-4xl font-bold">{t('commerce-market-catalog.title')}</h1>
      <p className="mt-150 text-lg text-fg-secondary" data-modern-mf-role="vertical">
        {t('commerce-market-catalog.role')}
      </p>
      <p className="sr-only" data-build-marker={ultramodernUiMarker.build} data-testid="ultramodern-ui-marker">
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
    </main>
  );
};

export default CommerceMarketCatalogHome;
