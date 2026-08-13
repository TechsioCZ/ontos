import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { crmI18nResources } from '../i18n/resources';
import { CrmPage } from '../routes/[lang]/crm/page';

const CrmFederatedPage = () => (
  <FederatedI18nBoundary
    defaultNamespace="crm"
    fallbackLanguage="en"
    resources={crmI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <CrmPage />
  </FederatedI18nBoundary>
);

export default CrmFederatedPage;
