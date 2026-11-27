import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/property-portfolio.json';
import enResource from '../locales/en/property-portfolio.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { 'property-portfolio': csResource },
  en: { 'property-portfolio': enResource },
};

const PropertyPortfolioRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="rounded-lg bg-surface p-5 shadow-xl"
      data-modern-boundary-id="verticalPropertyPortfolio"
      data-modern-mf-expose="./Route"
    >
      <h2 className="text-2xl font-bold">{t('property-portfolio.title')}</h2>
      <p className="mt-2 text-fg-secondary">{t('property-portfolio.routeSurface')}</p>
    </section>
  );
};

const PropertyPortfolioRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="property-portfolio"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <PropertyPortfolioRouteContent />
    </FederatedI18nBoundary>
  );
};

export default PropertyPortfolioRoute;
