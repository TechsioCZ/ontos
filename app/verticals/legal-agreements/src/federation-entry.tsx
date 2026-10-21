import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/legal-agreements.json';
import enResource from '../locales/en/legal-agreements.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { 'legal-agreements': csResource },
  en: { 'legal-agreements': enResource },
};

const LegalAgreementsRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="legalagreements:rounded-2xl legalagreements:bg-white/90 legalagreements:p-5 legalagreements:shadow-xl legalagreements:shadow-stone-900/10"
      data-modern-boundary-id="verticalLegalAgreements"
      data-modern-mf-expose="./Route"
    >
      <h2 className="legalagreements:text-2xl legalagreements:font-black">{t('legal-agreements.title')}</h2>
      <p className="legalagreements:mt-2 legalagreements:text-stone-600">
        {t('legal-agreements.routeSurface')}
      </p>
    </section>
  );
};

const LegalAgreementsRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="legal-agreements"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <LegalAgreementsRouteContent />
    </FederatedI18nBoundary>
  );
};
export default LegalAgreementsRoute;
