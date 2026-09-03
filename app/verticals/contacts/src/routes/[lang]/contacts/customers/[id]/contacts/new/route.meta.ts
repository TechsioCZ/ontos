import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/contacts/customers/:id/contacts/new',
  descriptionKey: 'contacts.pages.contactCreate.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'contacts.core.page.contact-create',
    moduleKey: 'contacts.core',
    role: 'page',
  }),
  id: 'contacts-contact-create',
  indexable: false,
  localisedPaths: {
    cs: '/contacts/customers/:id/contacts/new',
    en: '/contacts/customers/:id/contacts/new',
  },
  mfBoundaryId: 'verticalContacts',
  moduleId: 'contacts.core',
  namespace: 'contacts',
  ownerAppId: 'contacts',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'contacts.pages.contactCreate.title',
} as const;

export default routeMeta;
export { routeMeta };
