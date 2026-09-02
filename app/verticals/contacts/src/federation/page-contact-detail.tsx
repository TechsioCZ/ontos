import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { Toaster } from '@techsio/ui-kit/molecules/toast';
import { contactsI18nResources } from '../i18n/resources';
import { ContactDetailPage } from '../routes/[lang]/contacts/customers/[id]/contacts/[contactId]/page';
import '../routes/index.css';

type ContactDetailFederatedPageRouteParams = Readonly<Partial<Record<'id' | 'contactId', string>>>;

interface ContactDetailFederatedPageProps {
  readonly routeParams: ContactDetailFederatedPageRouteParams;
}

const ContactDetailFederatedPage = ({ routeParams }: ContactDetailFederatedPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace="contacts"
    fallbackLanguage="en"
    resources={contactsI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <ContactDetailPage routeParams={routeParams} />
    <Toaster />
  </FederatedI18nBoundary>
);

export default ContactDetailFederatedPage;
