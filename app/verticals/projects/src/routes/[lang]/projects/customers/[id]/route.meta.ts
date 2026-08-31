import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/projects/customers/:id',
  descriptionKey: 'projects.pages.customerDetail.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'projects.core.page.customer-detail',
    moduleKey: 'projects.core',
    role: 'page',
  }),
  id: 'projects-customer-detail',
  indexable: false,
  localisedPaths: {
    cs: '/projects/customers/:id',
    en: '/projects/customers/:id',
  },
  mfBoundaryId: 'verticalProjects',
  moduleId: 'projects.core',
  namespace: 'projects',
  ownerAppId: 'projects',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'projects.pages.customerDetail.title',
} as const;

export default routeMeta;
export { routeMeta };
