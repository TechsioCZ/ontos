import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { projectsI18nResources } from '../i18n/resources';
import { ContactEditPage } from '../routes/[lang]/projects/customers/[id]/contacts/[contactId]/edit/page';
import type { ContactEditPageTarget } from '../routes/[lang]/projects/customers/[id]/contacts/[contactId]/edit/page';

type ContactEditFederatedPageRouteParams = Readonly<Partial<Record<'id' | 'contactId', string>>>;

interface ContactEditFederatedPageProps {
  readonly routeParams: ContactEditFederatedPageRouteParams;
  readonly target: ContactEditPageTarget;
}

const ContactEditFederatedPage = ({ routeParams, target }: ContactEditFederatedPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace="projects"
    fallbackLanguage="en"
    resources={projectsI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <ContactEditPage routeParams={routeParams} target={target} />
  </FederatedI18nBoundary>
);

export default ContactEditFederatedPage;
