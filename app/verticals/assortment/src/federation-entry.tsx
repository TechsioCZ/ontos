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
      className="assortment:rounded-2xl assortment:bg-white/90 assortment:p-5 assortment:shadow-xl assortment:shadow-stone-900/10"
      data-modern-boundary-id="verticalAssortment"
      data-modern-mf-expose="./Route"
    >
      <h2 className="assortment:text-2xl assortment:font-black">{t('assortment.title')}</h2>
      <p className="assortment:mt-2 assortment:text-stone-600">{t('assortment.routeSurface')}</p>
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
