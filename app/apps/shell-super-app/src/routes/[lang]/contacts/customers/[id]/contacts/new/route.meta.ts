import { defineSystemModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/contacts/customers/:id/contacts/new',
  descriptionKey: 'shell.moduleTarget.seoDescription',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'authenticated_principal' },
    entrypointKey: 'shell-super-app.page.contacts-contact-create',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-contacts-contact-create',
  indexable: false,
  localisedPaths: {
    cs: '/contacts/customers/:id/contacts/new',
    en: '/contacts/customers/:id/contacts/new',
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
