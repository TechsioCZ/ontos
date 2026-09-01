import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { crmI18nResources } from '../i18n/resources';
import { CustomerDetailPage } from '../routes/[lang]/crm/customers/[id]/page';
import '../routes/index.css';

type CustomerDetailFederatedPageRouteParams = Readonly<Partial<Record<'id', string>>>;

interface CustomerDetailFederatedPageProps {
  readonly routeParams: CustomerDetailFederatedPageRouteParams;
}

const CustomerDetailFederatedPage = ({ routeParams }: CustomerDetailFederatedPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace="crm"
    fallbackLanguage="en"
    resources={crmI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <CustomerDetailPage routeParams={routeParams} />
  </FederatedI18nBoundary>
);

export default CustomerDetailFederatedPage;
