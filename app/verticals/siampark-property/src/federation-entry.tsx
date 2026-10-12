import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/siampark-property.json';
import enResource from '../locales/en/siampark-property.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { 'siampark-property': csResource },
  en: { 'siampark-property': enResource },
};

const SiamparkPropertyRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="siamparkproperty:rounded-2xl siamparkproperty:bg-white/90 siamparkproperty:p-5 siamparkproperty:shadow-xl siamparkproperty:shadow-stone-900/10"
      data-modern-boundary-id="verticalSiamparkProperty"
      data-modern-mf-expose="./Route"
    >
      <h2 className="siamparkproperty:text-2xl siamparkproperty:font-black">{t('siampark-property.title')}</h2>
      <p className="siamparkproperty:mt-2 siamparkproperty:text-stone-600">{t('siampark-property.routeSurface')}</p>
    </section>
  );
};

const SiamparkPropertyRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="siampark-property"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <SiamparkPropertyRouteContent />
    </FederatedI18nBoundary>
  );
};

export default SiamparkPropertyRoute;
