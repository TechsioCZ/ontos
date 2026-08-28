import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/projects/customers/:id/edit',
  descriptionKey: 'projects.pages.customerEdit.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'projects.core.page.customer-edit',
    moduleKey: 'projects.core',
    role: 'page',
  }),
  id: 'projects-customer-edit',
  indexable: false,
  localisedPaths: {
    cs: '/projects/customers/:id/edit',
    en: '/projects/customers/:id/edit',
  },
  mfBoundaryId: 'verticalProjects',
  moduleId: 'projects.core',
  namespace: 'projects',
  ownerAppId: 'projects',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'projects.pages.customerEdit.title',
} as const;

export default routeMeta;
export { routeMeta };
