import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/projects/customers/:id/contacts/:contactId',
  descriptionKey: 'projects.pages.contactDetail.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'projects.core.page.contact-detail',
    moduleKey: 'projects.core',
    role: 'page',
  }),
  id: 'projects-contact-detail',
  indexable: false,
  localisedPaths: {
    cs: '/projects/customers/:id/contacts/:contactId',
    en: '/projects/customers/:id/contacts/:contactId',
  },
  mfBoundaryId: 'verticalProjects',
  moduleId: 'projects.core',
  namespace: 'projects',
  ownerAppId: 'projects',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'projects.pages.contactDetail.title',
} as const;

export default routeMeta;
export { routeMeta };
