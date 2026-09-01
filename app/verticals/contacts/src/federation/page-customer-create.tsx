import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { contactsI18nResources } from '../i18n/resources';
import { CustomerCreatePage } from '../routes/[lang]/contacts/customers/[id]/new/page';
import type { CustomerCreatePageTarget } from '../routes/[lang]/contacts/customers/[id]/new/page';
import '../routes/index.css';

type CustomerCreateFederatedPageRouteParams = Readonly<Partial<Record<'id', string>>>;

interface CustomerCreateFederatedPageProps {
  readonly routeParams: CustomerCreateFederatedPageRouteParams;
  readonly target: CustomerCreatePageTarget;
}

const CustomerCreateFederatedPage = ({ routeParams, target }: CustomerCreateFederatedPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace="contacts"
    fallbackLanguage="en"
    resources={contactsI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <CustomerCreatePage routeParams={routeParams} target={target} />
  </FederatedI18nBoundary>
);

export default CustomerCreateFederatedPage;
