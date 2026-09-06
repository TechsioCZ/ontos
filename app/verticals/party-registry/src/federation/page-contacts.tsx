import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { partyRegistryI18nResources } from '../i18n/resources';
import { ContactsPage } from '../routes/[lang]/contacts/page';

const ContactsFederatedPage = () => (
  <FederatedI18nBoundary
    defaultNamespace="party-registry"
    fallbackLanguage="en"
    resources={partyRegistryI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <ContactsPage />
  </FederatedI18nBoundary>
);

export default ContactsFederatedPage;
