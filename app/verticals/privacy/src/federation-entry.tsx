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
      className="rounded-lg bg-surface p-250 shadow-xl"
      data-modern-boundary-id="verticalPrivacy"
      data-modern-mf-expose="./Route"
    >
      <h2 className="text-2xl font-bold">{t('privacy.title')}</h2>
      <p className="mt-150 text-fg-secondary">{t('privacy.routeSurface')}</p>
    </section>
  );
};

const PrivacyRoute = (): JSX.Element => (
  <FederatedI18nBoundary
    defaultNamespace="privacy"
    fallbackLanguage="en"
    resources={federatedI18nResources}
    supportedLanguages={federatedI18nLanguages}
  >
    <PrivacyRouteContent />
  </FederatedI18nBoundary>
);

export default PrivacyRoute;
