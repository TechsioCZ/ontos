import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { contactsI18nResources } from '../i18n/resources';
import '../routes/index.css';
import CustomersListPage from './page-customers-list.runtime.js';

const CustomersListFederatedPage = () => (
  <FederatedI18nBoundary
    defaultNamespace="contacts"
    fallbackLanguage="en"
    resources={contactsI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <CustomersListPage />
  </FederatedI18nBoundary>
);

export default CustomersListFederatedPage;
