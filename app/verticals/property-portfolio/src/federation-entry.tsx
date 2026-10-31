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
      className="propertyportfolio:rounded-2xl propertyportfolio:bg-white/90 propertyportfolio:p-5 propertyportfolio:shadow-xl propertyportfolio:shadow-stone-900/10"
      data-modern-boundary-id="verticalPropertyPortfolio"
      data-modern-mf-expose="./Route"
    >
      <h2 className="propertyportfolio:text-2xl propertyportfolio:font-black">{t('property-portfolio.title')}</h2>
      <p className="propertyportfolio:mt-2 propertyportfolio:text-stone-600">{t('property-portfolio.routeSurface')}</p>
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
