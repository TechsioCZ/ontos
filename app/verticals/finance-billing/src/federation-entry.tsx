import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/finance-billing.json';
import enResource from '../locales/en/finance-billing.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { 'finance-billing': csResource },
  en: { 'finance-billing': enResource },
};

const FinanceBillingRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="rounded-lg bg-surface p-5 shadow-xl"
      data-modern-boundary-id="verticalFinanceBilling"
      data-modern-mf-expose="./Route"
    >
      <h2 className="text-2xl font-bold">{t('finance-billing.title')}</h2>
      <p className="mt-2 text-fg-secondary">{t('finance-billing.routeSurface')}</p>
    </section>
  );
};

const FinanceBillingRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="finance-billing"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <FinanceBillingRouteContent />
    </FederatedI18nBoundary>
  );
};

export default FinanceBillingRoute;
