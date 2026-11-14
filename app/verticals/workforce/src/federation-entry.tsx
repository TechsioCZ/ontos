import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/workforce.json';
import enResource from '../locales/en/workforce.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { workforce: csResource },
  en: { workforce: enResource },
};

const WorkforceRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="workforce:rounded-2xl workforce:bg-white/90 workforce:p-5 workforce:shadow-xl workforce:shadow-stone-900/10"
      data-modern-boundary-id="verticalWorkforce"
      data-modern-mf-expose="./Route"
    >
      <h2 className="workforce:text-2xl workforce:font-black">{t('workforce.title')}</h2>
      <p className="workforce:mt-2 workforce:text-stone-600">{t('workforce.routeSurface')}</p>
    </section>
  );
};

const WorkforceRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="workforce"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <WorkforceRouteContent />
    </FederatedI18nBoundary>
  );
};

export default WorkforceRoute;
