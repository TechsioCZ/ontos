import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/catalog.json';
import enResource from '../locales/en/catalog.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { catalog: csResource },
  en: { catalog: enResource },
};

const CatalogRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="catalog:rounded-2xl catalog:bg-white/90 catalog:p-5 catalog:shadow-xl catalog:shadow-stone-900/10"
      data-modern-boundary-id="verticalCatalog"
      data-modern-mf-expose="./Route"
    >
      <h2 className="catalog:text-2xl catalog:font-black">{t('catalog.title')}</h2>
      <p className="catalog:mt-2 catalog:text-stone-600">{t('catalog.routeSurface')}</p>
    </section>
  );
};

const CatalogRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="catalog"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <CatalogRouteContent />
    </FederatedI18nBoundary>
  );
};

export default CatalogRoute;
