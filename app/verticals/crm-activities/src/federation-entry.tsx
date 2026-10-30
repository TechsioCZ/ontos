import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/crm-activities.json';
import enResource from '../locales/en/crm-activities.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { 'crm-activities': csResource },
  en: { 'crm-activities': enResource },
};

const CrmActivitiesRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="crmactivities:rounded-2xl crmactivities:bg-white/90 crmactivities:p-5 crmactivities:shadow-xl crmactivities:shadow-stone-900/10"
      data-modern-boundary-id="verticalCrmActivities"
      data-modern-mf-expose="./Route"
    >
      <h2 className="crmactivities:text-2xl crmactivities:font-black">{t('crm-activities.title')}</h2>
      <p className="crmactivities:mt-2 crmactivities:text-stone-600">{t('crm-activities.routeSurface')}</p>
    </section>
  );
};

const CrmActivitiesRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="crm-activities"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <CrmActivitiesRouteContent />
    </FederatedI18nBoundary>
  );
};

export default CrmActivitiesRoute;
