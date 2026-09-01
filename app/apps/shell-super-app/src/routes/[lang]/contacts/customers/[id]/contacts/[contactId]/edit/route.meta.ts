import { defineSystemModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/contacts/customers/:id/contacts/:contactId/edit',
  descriptionKey: 'shell.moduleTarget.seoDescription',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    entrypointKey: 'shell-super-app.page.contacts-contact-edit',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-contacts-contact-edit',
  indexable: false,
  localisedPaths: {
    cs: '/contacts/customers/:id/contacts/:contactId/edit',
    en: '/contacts/customers/:id/contacts/:contactId/edit',
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
