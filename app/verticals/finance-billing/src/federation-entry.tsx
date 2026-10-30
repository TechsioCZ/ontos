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
      className="financebilling:rounded-2xl financebilling:bg-white/90 financebilling:p-5 financebilling:shadow-xl financebilling:shadow-stone-900/10"
      data-modern-boundary-id="verticalFinanceBilling"
      data-modern-mf-expose="./Route"
    >
      <h2 className="financebilling:text-2xl financebilling:font-black">{t('finance-billing.title')}</h2>
      <p className="financebilling:mt-2 financebilling:text-stone-600">{t('finance-billing.routeSurface')}</p>
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
