import { defineSystemModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/projects/customers/:id/contacts/:contactId',
  descriptionKey: 'shell.moduleTarget.seoDescription',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    entrypointKey: 'shell-super-app.page.projects-contact-detail',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-projects-contact-detail',
  indexable: false,
  localisedPaths: {
    cs: '/projects/customers/:id/contacts/:contactId',
    en: '/projects/customers/:id/contacts/:contactId',
  },
  mfBoundaryId: 'shellSuperApp',
  namespace: 'shell',
  ownerAppId: 'shell-super-app',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'shell.moduleTarget.title',
} as const;

export default routeMeta;
export { routeMeta };
