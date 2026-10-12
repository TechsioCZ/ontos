import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/siampark-billing-finance.json';
import enResource from '../locales/en/siampark-billing-finance.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { 'siampark-billing-finance': csResource },
  en: { 'siampark-billing-finance': enResource },
};

const SiamparkBillingFinanceRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="siamparkbillingfinance:rounded-2xl siamparkbillingfinance:bg-white/90 siamparkbillingfinance:p-5 siamparkbillingfinance:shadow-xl siamparkbillingfinance:shadow-stone-900/10"
      data-modern-boundary-id="verticalSiamparkBillingFinance"
      data-modern-mf-expose="./Route"
    >
      <h2 className="siamparkbillingfinance:text-2xl siamparkbillingfinance:font-black">
        {t('siampark-billing-finance.title')}
      </h2>
      <p className="siamparkbillingfinance:mt-2 siamparkbillingfinance:text-stone-600">
        {t('siampark-billing-finance.routeSurface')}
      </p>
    </section>
  );
};

const SiamparkBillingFinanceRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="siampark-billing-finance"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <SiamparkBillingFinanceRouteContent />
    </FederatedI18nBoundary>
  );
};

export default SiamparkBillingFinanceRoute;
