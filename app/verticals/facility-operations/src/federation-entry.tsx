import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import { csResource, enResource } from './i18n/resources.ts';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { 'facility-operations': csResource },
  en: { 'facility-operations': enResource },
};

const FacilityOperationsRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="facilityoperations:rounded-2xl facilityoperations:bg-white/90 facilityoperations:p-5 facilityoperations:shadow-xl facilityoperations:shadow-stone-900/10"
      data-modern-boundary-id="verticalFacilityOperations"
      data-modern-mf-expose="./Route"
    >
      <h2 className="facilityoperations:text-2xl facilityoperations:font-black">{t('facility-operations.title')}</h2>
      <p className="facilityoperations:mt-2 facilityoperations:text-stone-600">{t('facility-operations.routeSurface')}</p>
    </section>
  );
};

const FacilityOperationsRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="facility-operations"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <FacilityOperationsRouteContent />
    </FederatedI18nBoundary>
  );
};

export default FacilityOperationsRoute;
