import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/projects/customers/:id/new',
  descriptionKey: 'projects.pages.customerCreate.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'projects.core.page.customer-create',
    moduleKey: 'projects.core',
    role: 'page',
  }),
  id: 'projects-customer-create',
  indexable: false,
  localisedPaths: {
    cs: '/projects/customers/:id/new',
    en: '/projects/customers/:id/new',
  },
  mfBoundaryId: 'verticalProjects',
  moduleId: 'projects.core',
  namespace: 'projects',
  ownerAppId: 'projects',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'projects.pages.customerCreate.title',
} as const;

export default routeMeta;
export { routeMeta };
