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
      className="rounded-lg bg-surface p-5 shadow-xl"
      data-modern-boundary-id="verticalTagging"
      data-modern-mf-expose="./Route"
    >
      <h2 className="text-2xl font-bold">{t('tagging.title')}</h2>
      <p className="mt-2 text-fg-secondary">{t('tagging.routeSurface')}</p>
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
