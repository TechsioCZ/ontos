import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/sales-pipeline.json';
import enResource from '../locales/en/sales-pipeline.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { 'sales-pipeline': csResource },
  en: { 'sales-pipeline': enResource },
};

const SalesPipelineRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="rounded-lg bg-surface p-5 shadow-xl"
      data-modern-boundary-id="verticalSalesPipeline"
      data-modern-mf-expose="./Route"
    >
      <h2 className="text-2xl font-bold">{t('sales-pipeline.title')}</h2>
      <p className="mt-2 text-fg-secondary">{t('sales-pipeline.routeSurface')}</p>
    </section>
  );
};

const SalesPipelineRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="sales-pipeline"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <SalesPipelineRouteContent />
    </FederatedI18nBoundary>
  );
};

export default SalesPipelineRoute;
