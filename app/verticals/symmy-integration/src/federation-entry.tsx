import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/symmy-integration.json';
import enResource from '../locales/en/symmy-integration.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { 'symmy-integration': csResource },
  en: { 'symmy-integration': enResource },
};

const SymmyIntegrationRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="rounded-lg bg-surface p-5 shadow-xl"
      data-modern-boundary-id="verticalSymmyIntegration"
      data-modern-mf-expose="./Route"
    >
      <h2 className="text-2xl font-bold">{t('symmy-integration.title')}</h2>
      <p className="mt-2 text-fg-secondary">{t('symmy-integration.routeSurface')}</p>
    </section>
  );
};

const SymmyIntegrationRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="symmy-integration"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <SymmyIntegrationRouteContent />
    </FederatedI18nBoundary>
  );
};

export default SymmyIntegrationRoute;
