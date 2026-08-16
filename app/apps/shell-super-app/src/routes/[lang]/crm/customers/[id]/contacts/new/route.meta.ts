import { defineSystemModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/crm/customers/:id/contacts/new',
  descriptionKey: 'shell.moduleTarget.seoDescription',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    entrypointKey: 'shell-super-app.page.crm-contact-create',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-crm-contact-create',
  indexable: false,
  localisedPaths: {
    cs: '/crm/customers/:id/contacts/new',
    en: '/crm/customers/:id/contacts/new',
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
