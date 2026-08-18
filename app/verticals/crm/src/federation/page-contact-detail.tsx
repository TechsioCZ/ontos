import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { crmI18nResources } from '../i18n/resources';
import { ContactDetailPage } from '../routes/[lang]/crm/customers/[id]/contacts/[contactId]/page';
import '../routes/index.css';

type ContactDetailFederatedPageRouteParams = Readonly<Partial<Record<'id' | 'contactId', string>>>;

interface ContactDetailFederatedPageProps {
  readonly routeParams: ContactDetailFederatedPageRouteParams;
}

const ContactDetailFederatedPage = ({ routeParams }: ContactDetailFederatedPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace="crm"
    fallbackLanguage="en"
    resources={crmI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <ContactDetailPage routeParams={routeParams} />
  </FederatedI18nBoundary>
);

export default ContactDetailFederatedPage;
