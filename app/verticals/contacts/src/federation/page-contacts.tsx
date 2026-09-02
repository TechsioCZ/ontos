import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { Toaster } from '@techsio/ui-kit/molecules/toast';
import { contactsI18nResources } from '../i18n/resources';
import { ContactsPage } from '../routes/[lang]/contacts/page';

const ContactsFederatedPage = () => (
  <FederatedI18nBoundary
    defaultNamespace="contacts"
    fallbackLanguage="en"
    resources={contactsI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <ContactsPage />
    <Toaster />
  </FederatedI18nBoundary>
);

export default ContactsFederatedPage;
