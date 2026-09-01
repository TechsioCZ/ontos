import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { crmI18nResources } from '../i18n/resources';
import { ContactCreatePage } from '../routes/[lang]/crm/customers/[id]/contacts/new/page';
import type { ContactCreatePageTarget } from '../routes/[lang]/crm/customers/[id]/contacts/new/page';
import '../routes/index.css';

type ContactCreateFederatedPageRouteParams = Readonly<Partial<Record<'id', string>>>;

interface ContactCreateFederatedPageProps {
  readonly routeParams: ContactCreateFederatedPageRouteParams;
  readonly target: ContactCreatePageTarget;
}

const ContactCreateFederatedPage = ({ routeParams, target }: ContactCreateFederatedPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace="crm"
    fallbackLanguage="en"
    resources={crmI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <ContactCreatePage routeParams={routeParams} target={target} />
  </FederatedI18nBoundary>
);

export default ContactCreateFederatedPage;
