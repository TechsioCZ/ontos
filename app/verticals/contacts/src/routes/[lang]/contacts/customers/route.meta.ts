import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/contacts/customers',
  descriptionKey: 'contacts.pages.customersList.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'contacts.core.page.customers-list',
    moduleKey: 'contacts.core',
    role: 'page',
  }),
  id: 'contacts-customers-list',
  indexable: false,
  localisedPaths: {
    cs: '/contacts/customers',
    en: '/contacts/customers',
  },
  mfBoundaryId: 'verticalContacts',
  moduleId: 'contacts.core',
  namespace: 'contacts',
  ownerAppId: 'contacts',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'contacts.pages.customersList.title',
} as const;

export default routeMeta;
export { routeMeta };
