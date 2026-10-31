import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/property-leasing.json';
import enResource from '../locales/en/property-leasing.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { 'property-leasing': csResource },
  en: { 'property-leasing': enResource },
};

const PropertyLeasingRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="propertyleasing:rounded-2xl propertyleasing:bg-white/90 propertyleasing:p-5 propertyleasing:shadow-xl propertyleasing:shadow-stone-900/10"
      data-modern-boundary-id="verticalPropertyLeasing"
      data-modern-mf-expose="./Route"
    >
      <h2 className="propertyleasing:text-2xl propertyleasing:font-black">{t('property-leasing.title')}</h2>
      <p className="propertyleasing:mt-2 propertyleasing:text-stone-600">{t('property-leasing.routeSurface')}</p>
    </section>
  );
};

const PropertyLeasingRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="property-leasing"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <PropertyLeasingRouteContent />
    </FederatedI18nBoundary>
  );
};
export default PropertyLeasingRoute;
