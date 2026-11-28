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
      className="rounded-lg bg-surface p-5 shadow-xl"
      data-modern-boundary-id="verticalPropertyLeasing"
      data-modern-mf-expose="./Route"
    >
      <h2 className="text-2xl font-bold">{t('property-leasing.title')}</h2>
      <p className="mt-2 text-fg-secondary">{t('property-leasing.routeSurface')}</p>
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
