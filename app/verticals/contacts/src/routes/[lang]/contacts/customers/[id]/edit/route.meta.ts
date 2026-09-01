import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/contacts/customers/:id/edit',
  descriptionKey: 'contacts.pages.customerEdit.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'contacts.core.page.customer-edit',
    moduleKey: 'contacts.core',
    role: 'page',
  }),
  id: 'contacts-customer-edit',
  indexable: false,
  localisedPaths: {
    cs: '/contacts/customers/:id/edit',
    en: '/contacts/customers/:id/edit',
  },
  mfBoundaryId: 'verticalContacts',
  moduleId: 'contacts.core',
  namespace: 'contacts',
  ownerAppId: 'contacts',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'contacts.pages.customerEdit.title',
} as const;

export default routeMeta;
export { routeMeta };
