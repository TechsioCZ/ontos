import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { projectsI18nResources } from '../i18n/resources';
import { CustomerEditPage } from '../routes/[lang]/projects/customers/[id]/edit/page';
import type { CustomerEditPageTarget } from '../routes/[lang]/projects/customers/[id]/edit/page';
import '../routes/index.css';

type CustomerEditFederatedPageRouteParams = Readonly<Partial<Record<'id', string>>>;

interface CustomerEditFederatedPageProps {
  readonly routeParams: CustomerEditFederatedPageRouteParams;
  readonly target: CustomerEditPageTarget;
}

const CustomerEditFederatedPage = ({ routeParams, target }: CustomerEditFederatedPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace="projects"
    fallbackLanguage="en"
    resources={projectsI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <CustomerEditPage routeParams={routeParams} target={target} />
  </FederatedI18nBoundary>
);

export default CustomerEditFederatedPage;
