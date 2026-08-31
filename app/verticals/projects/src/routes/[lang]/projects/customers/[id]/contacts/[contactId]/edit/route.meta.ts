import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/projects/customers/:id/contacts/:contactId/edit',
  descriptionKey: 'projects.pages.contactEdit.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'projects.core.page.contact-edit',
    moduleKey: 'projects.core',
    role: 'page',
  }),
  id: 'projects-contact-edit',
  indexable: false,
  localisedPaths: {
    cs: '/projects/customers/:id/contacts/:contactId/edit',
    en: '/projects/customers/:id/contacts/:contactId/edit',
  },
  mfBoundaryId: 'verticalProjects',
  moduleId: 'projects.core',
  namespace: 'projects',
  ownerAppId: 'projects',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'projects.pages.contactEdit.title',
} as const;

export default routeMeta;
export { routeMeta };
