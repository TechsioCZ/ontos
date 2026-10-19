import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import { csResource, enResource } from './i18n/resources.ts';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { 'siampark-ops': csResource },
  en: { 'siampark-ops': enResource },
};

const SiamparkOpsRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="siamparkops:rounded-2xl siamparkops:bg-white/90 siamparkops:p-5 siamparkops:shadow-xl siamparkops:shadow-stone-900/10"
      data-modern-boundary-id="verticalSiamparkOps"
      data-modern-mf-expose="./Route"
    >
      <h2 className="siamparkops:text-2xl siamparkops:font-black">{t('siampark-ops.title')}</h2>
      <p className="siamparkops:mt-2 siamparkops:text-stone-600">{t('siampark-ops.routeSurface')}</p>
    </section>
  );
};

const SiamparkOpsRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="siampark-ops"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <SiamparkOpsRouteContent />
    </FederatedI18nBoundary>
  );
};

export default SiamparkOpsRoute;
