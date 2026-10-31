import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/tagging.json';
import enResource from '../locales/en/tagging.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { tagging: csResource },
  en: { tagging: enResource },
};

const TaggingRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="tagging:rounded-2xl tagging:bg-white/90 tagging:p-5 tagging:shadow-xl tagging:shadow-stone-900/10"
      data-modern-boundary-id="verticalTagging"
      data-modern-mf-expose="./Route"
    >
      <h2 className="tagging:text-2xl tagging:font-black">{t('tagging.title')}</h2>
      <p className="tagging:mt-2 tagging:text-stone-600">{t('tagging.routeSurface')}</p>
    </section>
  );
};

const TaggingRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="tagging"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <TaggingRouteContent />
    </FederatedI18nBoundary>
  );
};

export default TaggingRoute;
