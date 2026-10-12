import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/siampark-work.json';
import enResource from '../locales/en/siampark-work.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { 'siampark-work': csResource },
  en: { 'siampark-work': enResource },
};

const SiamparkWorkRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="siamparkwork:rounded-2xl siamparkwork:bg-white/90 siamparkwork:p-5 siamparkwork:shadow-xl siamparkwork:shadow-stone-900/10"
      data-modern-boundary-id="verticalSiamparkWork"
      data-modern-mf-expose="./Route"
    >
      <h2 className="siamparkwork:text-2xl siamparkwork:font-black">{t('siampark-work.title')}</h2>
      <p className="siamparkwork:mt-2 siamparkwork:text-stone-600">{t('siampark-work.routeSurface')}</p>
    </section>
  );
};

const SiamparkWorkRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="siampark-work"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <SiamparkWorkRouteContent />
    </FederatedI18nBoundary>
  );
};

export default SiamparkWorkRoute;
