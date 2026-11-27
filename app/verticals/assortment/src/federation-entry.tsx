import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/assortment.json';
import enResource from '../locales/en/assortment.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { assortment: csResource },
  en: { assortment: enResource },
};

const AssortmentRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="rounded-lg bg-surface p-250 shadow-xl"
      data-modern-boundary-id="verticalAssortment"
      data-modern-mf-expose="./Route"
    >
      <h2 className="text-2xl font-bold">{t('assortment.title')}</h2>
      <p className="mt-150 text-fg-secondary">{t('assortment.routeSurface')}</p>
    </section>
  );
};

const AssortmentRoute = (): JSX.Element => (
  <FederatedI18nBoundary
    defaultNamespace="assortment"
    fallbackLanguage="en"
    resources={federatedI18nResources}
    supportedLanguages={federatedI18nLanguages}
  >
    <AssortmentRouteContent />
  </FederatedI18nBoundary>
);

export default AssortmentRoute;
