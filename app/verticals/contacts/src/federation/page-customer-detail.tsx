import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { Toaster } from '@techsio/ui-kit/molecules/toast';
import { contactsI18nResources } from '../i18n/resources';
import { CustomerDetailPage } from '../routes/[lang]/contacts/customers/[id]/page';
import '../routes/index.css';

type CustomerDetailFederatedPageRouteParams = Readonly<Partial<Record<'id', string>>>;

interface CustomerDetailFederatedPageProps {
  readonly routeParams: CustomerDetailFederatedPageRouteParams;
}

const CustomerDetailFederatedPage = ({ routeParams }: CustomerDetailFederatedPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace="contacts"
    fallbackLanguage="en"
    resources={contactsI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <CustomerDetailPage routeParams={routeParams} />
    <Toaster />
  </FederatedI18nBoundary>
);

export default CustomerDetailFederatedPage;
