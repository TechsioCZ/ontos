import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { Toaster } from '@techsio/ui-kit/molecules/toast';
import { contactsI18nResources } from '../i18n/resources';
import { ContactEditPage } from '../routes/[lang]/contacts/customers/[id]/contacts/[contactId]/edit/page';
import type { ContactEditPageTarget } from '../routes/[lang]/contacts/customers/[id]/contacts/[contactId]/edit/page';

type ContactEditFederatedPageRouteParams = Readonly<Partial<Record<'id' | 'contactId', string>>>;

interface ContactEditFederatedPageProps {
  readonly routeParams: ContactEditFederatedPageRouteParams;
  readonly target: ContactEditPageTarget;
}

const ContactEditFederatedPage = ({ routeParams, target }: ContactEditFederatedPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace="contacts"
    fallbackLanguage="en"
    resources={contactsI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <ContactEditPage routeParams={routeParams} target={target} />
    <Toaster />
  </FederatedI18nBoundary>
);

export default ContactEditFederatedPage;
