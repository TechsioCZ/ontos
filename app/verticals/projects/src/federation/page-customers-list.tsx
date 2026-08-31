import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { projectsI18nResources } from '../i18n/resources';
import '../routes/index.css';
import CustomersListPage from './page-customers-list.runtime.js';

const CustomersListFederatedPage = () => (
  <FederatedI18nBoundary
    defaultNamespace="projects"
    fallbackLanguage="en"
    resources={projectsI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <CustomersListPage />
  </FederatedI18nBoundary>
);

export default CustomersListFederatedPage;
