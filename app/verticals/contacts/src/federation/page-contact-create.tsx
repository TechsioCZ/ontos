import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { Toaster } from '@techsio/ui-kit/molecules/toast';
import { contactsI18nResources } from '../i18n/resources';
import { ContactCreatePage } from '../routes/[lang]/contacts/customers/[id]/contacts/new/page';
import type { ContactCreatePageTarget } from '../routes/[lang]/contacts/customers/[id]/contacts/new/page';
import '../routes/index.css';

type ContactCreateFederatedPageRouteParams = Readonly<Partial<Record<'id', string>>>;

interface ContactCreateFederatedPageProps {
  readonly routeParams: ContactCreateFederatedPageRouteParams;
  readonly target: ContactCreatePageTarget;
}

const ContactCreateFederatedPage = ({ routeParams, target }: ContactCreateFederatedPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace="contacts"
    fallbackLanguage="en"
    resources={contactsI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <ContactCreatePage routeParams={routeParams} target={target} />
    <Toaster />
  </FederatedI18nBoundary>
);

export default ContactCreateFederatedPage;
