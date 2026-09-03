import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/contacts/customers/:id',
  descriptionKey: 'contacts.pages.customerDetail.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'contacts.core.page.customer-detail',
    moduleKey: 'contacts.core',
    role: 'page',
  }),
  id: 'contacts-customer-detail',
  indexable: false,
  localisedPaths: {
    cs: '/contacts/customers/:id',
    en: '/contacts/customers/:id',
  },
  mfBoundaryId: 'verticalContacts',
  moduleId: 'contacts.core',
  namespace: 'contacts',
  ownerAppId: 'contacts',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'contacts.pages.customerDetail.title',
} as const;

export default routeMeta;
export { routeMeta };
