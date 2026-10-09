import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/privacy.json';
import enResource from '../locales/en/privacy.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { privacy: csResource },
  en: { privacy: enResource },
};

const PrivacyRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="privacy:rounded-2xl privacy:bg-white/90 privacy:p-5 privacy:shadow-xl privacy:shadow-stone-900/10"
      data-modern-boundary-id="verticalPrivacy"
      data-modern-mf-expose="./Route"
    >
      <h2 className="privacy:text-2xl privacy:font-black">{t('privacy.title')}</h2>
      <p className="privacy:mt-2 privacy:text-stone-600">{t('privacy.routeSurface')}</p>
    </section>
  );
};

const PrivacyRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="privacy"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <PrivacyRouteContent />
    </FederatedI18nBoundary>
  );
};

export default PrivacyRoute;
