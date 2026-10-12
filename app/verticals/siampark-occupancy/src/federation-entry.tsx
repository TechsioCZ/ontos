import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/siampark-occupancy.json';
import enResource from '../locales/en/siampark-occupancy.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { 'siampark-occupancy': csResource },
  en: { 'siampark-occupancy': enResource },
};

const SiamparkOccupancyRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="siamparkoccupancy:rounded-2xl siamparkoccupancy:bg-white/90 siamparkoccupancy:p-5 siamparkoccupancy:shadow-xl siamparkoccupancy:shadow-stone-900/10"
      data-modern-boundary-id="verticalSiamparkOccupancy"
      data-modern-mf-expose="./Route"
    >
      <h2 className="siamparkoccupancy:text-2xl siamparkoccupancy:font-black">{t('siampark-occupancy.title')}</h2>
      <p className="siamparkoccupancy:mt-2 siamparkoccupancy:text-stone-600">{t('siampark-occupancy.routeSurface')}</p>
    </section>
  );
};

const SiamparkOccupancyRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="siampark-occupancy"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <SiamparkOccupancyRouteContent />
    </FederatedI18nBoundary>
  );
};
export default SiamparkOccupancyRoute;
