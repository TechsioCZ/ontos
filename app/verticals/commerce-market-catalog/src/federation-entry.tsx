import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/commerce-market-catalog.json';
import enResource from '../locales/en/commerce-market-catalog.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { 'commerce-market-catalog': csResource },
  en: { 'commerce-market-catalog': enResource },
};

const CommerceMarketCatalogRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="rounded-lg bg-surface p-250 shadow-xl"
      data-modern-boundary-id="verticalCommerceMarketCatalog"
      data-modern-mf-expose="./Route"
    >
      <h2 className="text-2xl font-bold">{t('commerce-market-catalog.title')}</h2>
      <p className="mt-150 text-fg-secondary">{t('commerce-market-catalog.routeSurface')}</p>
    </section>
  );
};

const CommerceMarketCatalogRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="commerce-market-catalog"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <CommerceMarketCatalogRouteContent />
    </FederatedI18nBoundary>
  );
};

export default CommerceMarketCatalogRoute;
