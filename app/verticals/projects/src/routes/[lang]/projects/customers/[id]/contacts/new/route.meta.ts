import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/projects/customers/:id/contacts/new',
  descriptionKey: 'projects.pages.contactCreate.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'projects.core.page.contact-create',
    moduleKey: 'projects.core',
    role: 'page',
  }),
  id: 'projects-contact-create',
  indexable: false,
  localisedPaths: {
    cs: '/projects/customers/:id/contacts/new',
    en: '/projects/customers/:id/contacts/new',
  },
  mfBoundaryId: 'verticalProjects',
  moduleId: 'projects.core',
  namespace: 'projects',
  ownerAppId: 'projects',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'projects.pages.contactCreate.title',
} as const;

export default routeMeta;
export { routeMeta };
