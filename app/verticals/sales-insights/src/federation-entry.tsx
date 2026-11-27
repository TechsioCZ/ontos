import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/sales-insights.json';
import enResource from '../locales/en/sales-insights.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { 'sales-insights': csResource },
  en: { 'sales-insights': enResource },
};

const SalesInsightsRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="rounded-lg bg-surface p-5 shadow-xl"
      data-modern-boundary-id="verticalSalesInsights"
      data-modern-mf-expose="./Route"
    >
      <h2 className="text-2xl font-bold">{t('sales-insights.title')}</h2>
      <p className="mt-2 text-fg-secondary">{t('sales-insights.routeSurface')}</p>
    </section>
  );
};

const SalesInsightsRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="sales-insights"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <SalesInsightsRouteContent />
    </FederatedI18nBoundary>
  );
};

export default SalesInsightsRoute;
