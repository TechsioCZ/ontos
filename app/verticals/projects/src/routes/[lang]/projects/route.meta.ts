import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/projects',
  descriptionKey: 'projects.pages.projects.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'projects.core.page.projects',
    moduleKey: 'projects.core',
    role: 'page',
  }),
  id: 'projects-projects',
  indexable: false,
  localisedPaths: {
    cs: '/projects',
    en: '/projects',
  },
  mfBoundaryId: 'verticalProjects',
  moduleId: 'projects.core',
  namespace: 'projects',
  ownerAppId: 'projects',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'projects.pages.projects.title',
} as const;

export default routeMeta;
export { routeMeta };
