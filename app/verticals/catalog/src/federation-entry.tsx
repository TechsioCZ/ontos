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
      className="rounded-lg bg-surface p-250 shadow-xl"
      data-modern-boundary-id="verticalCatalog"
      data-modern-mf-expose="./Route"
    >
      <h2 className="text-2xl font-bold">{t('catalog.title')}</h2>
      <p className="mt-150 text-fg-secondary">{t('catalog.routeSurface')}</p>
    </section>
  );
};

const CatalogRoute = (_props: Record<string, never>): JSX.Element => (
  <FederatedI18nBoundary
    defaultNamespace="catalog"
    fallbackLanguage="en"
    resources={federatedI18nResources}
    supportedLanguages={federatedI18nLanguages}
  >
    <CatalogRouteContent />
  </FederatedI18nBoundary>
);

export default CatalogRoute;
