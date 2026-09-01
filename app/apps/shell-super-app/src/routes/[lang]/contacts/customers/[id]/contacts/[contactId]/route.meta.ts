import { defineSystemModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/contacts/customers/:id/contacts/:contactId',
  descriptionKey: 'shell.moduleTarget.seoDescription',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    entrypointKey: 'shell-super-app.page.contacts-contact-detail',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-contacts-contact-detail',
  indexable: false,
  localisedPaths: {
    cs: '/contacts/customers/:id/contacts/:contactId',
    en: '/contacts/customers/:id/contacts/:contactId',
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
