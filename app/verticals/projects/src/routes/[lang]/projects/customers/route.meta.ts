import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/projects/customers',
  descriptionKey: 'projects.pages.customersList.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'projects.core.page.customers-list',
    moduleKey: 'projects.core',
    role: 'page',
  }),
  id: 'projects-customers-list',
  indexable: false,
  localisedPaths: {
    cs: '/projects/customers',
    en: '/projects/customers',
  },
  mfBoundaryId: 'verticalProjects',
  moduleId: 'projects.core',
  namespace: 'projects',
  ownerAppId: 'projects',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'projects.pages.customersList.title',
} as const;

export default routeMeta;
export { routeMeta };
