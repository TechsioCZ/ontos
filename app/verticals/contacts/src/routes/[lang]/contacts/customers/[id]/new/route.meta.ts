import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/contacts/customers/:id/new',
  descriptionKey: 'contacts.pages.customerCreate.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'contacts.core.page.customer-create',
    moduleKey: 'contacts.core',
    role: 'page',
  }),
  id: 'contacts-customer-create',
  indexable: false,
  localisedPaths: {
    cs: '/contacts/customers/:id/new',
    en: '/contacts/customers/:id/new',
  },
  mfBoundaryId: 'verticalContacts',
  moduleId: 'contacts.core',
  namespace: 'contacts',
  ownerAppId: 'contacts',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'contacts.pages.customerCreate.title',
} as const;

export default routeMeta;
export { routeMeta };
