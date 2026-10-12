import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/siampark-agreements.json';
import enResource from '../locales/en/siampark-agreements.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { 'siampark-agreements': csResource },
  en: { 'siampark-agreements': enResource },
};

const SiamparkAgreementsRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="siamparkagreements:rounded-2xl siamparkagreements:bg-white/90 siamparkagreements:p-5 siamparkagreements:shadow-xl siamparkagreements:shadow-stone-900/10"
      data-modern-boundary-id="verticalSiamparkAgreements"
      data-modern-mf-expose="./Route"
    >
      <h2 className="siamparkagreements:text-2xl siamparkagreements:font-black">{t('siampark-agreements.title')}</h2>
      <p className="siamparkagreements:mt-2 siamparkagreements:text-stone-600">
        {t('siampark-agreements.routeSurface')}
      </p>
    </section>
  );
};

const SiamparkAgreementsRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="siampark-agreements"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <SiamparkAgreementsRouteContent />
    </FederatedI18nBoundary>
  );
};
export default SiamparkAgreementsRoute;
