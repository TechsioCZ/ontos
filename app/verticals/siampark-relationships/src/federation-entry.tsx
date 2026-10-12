import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/siampark-relationships.json';
import enResource from '../locales/en/siampark-relationships.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { 'siampark-relationships': csResource },
  en: { 'siampark-relationships': enResource },
};

const SiamparkRelationshipsRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="siamparkrelationships:rounded-2xl siamparkrelationships:bg-white/90 siamparkrelationships:p-5 siamparkrelationships:shadow-xl siamparkrelationships:shadow-stone-900/10"
      data-modern-boundary-id="verticalSiamparkRelationships"
      data-modern-mf-expose="./Route"
    >
      <h2 className="siamparkrelationships:text-2xl siamparkrelationships:font-black">
        {t('siampark-relationships.title')}
      </h2>
      <p className="siamparkrelationships:mt-2 siamparkrelationships:text-stone-600">
        {t('siampark-relationships.routeSurface')}
      </p>
    </section>
  );
};

const SiamparkRelationshipsRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="siampark-relationships"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <SiamparkRelationshipsRouteContent />
    </FederatedI18nBoundary>
  );
};

export default SiamparkRelationshipsRoute;
