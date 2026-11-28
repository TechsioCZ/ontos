import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/crm.json';
import enResource from '../locales/en/crm.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { crm: csResource },
  en: { crm: enResource },
};

const CrmRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="rounded-lg bg-surface p-5 shadow-xl"
      data-modern-boundary-id="verticalCrm"
      data-modern-mf-expose="./Route"
    >
      <h2 className="text-2xl font-bold">{t('crm.title')}</h2>
      <p className="mt-2 text-fg-secondary">{t('crm.routeSurface')}</p>
    </section>
  );
};

const CrmRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="crm"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <CrmRouteContent />
    </FederatedI18nBoundary>
  );
};

export default CrmRoute;
