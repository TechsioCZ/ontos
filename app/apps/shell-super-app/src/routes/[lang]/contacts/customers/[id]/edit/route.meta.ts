import { defineSystemModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/contacts/customers/:id/edit',
  descriptionKey: 'shell.moduleTarget.seoDescription',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    entrypointKey: 'shell-super-app.page.contacts-customer-edit',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-contacts-customer-edit',
  indexable: false,
  localisedPaths: {
    cs: '/contacts/customers/:id/edit',
    en: '/contacts/customers/:id/edit',
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
