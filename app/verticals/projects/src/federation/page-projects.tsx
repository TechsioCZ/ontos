import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { projectsI18nResources } from '../i18n/resources';
import { ProjectsPage } from '../routes/[lang]/projects/page';

const ProjectsFederatedPage = () => (
  <FederatedI18nBoundary
    defaultNamespace="projects"
    fallbackLanguage="en"
    resources={projectsI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <ProjectsPage />
  </FederatedI18nBoundary>
);

export default ProjectsFederatedPage;
