import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/contacts/customers/:id/contacts/:contactId/edit',
  descriptionKey: 'contacts.pages.contactEdit.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'contacts.core.page.contact-edit',
    moduleKey: 'contacts.core',
    role: 'page',
  }),
  id: 'contacts-contact-edit',
  indexable: false,
  localisedPaths: {
    cs: '/contacts/customers/:id/contacts/:contactId/edit',
    en: '/contacts/customers/:id/contacts/:contactId/edit',
  },
  mfBoundaryId: 'verticalContacts',
  moduleId: 'contacts.core',
  namespace: 'contacts',
  ownerAppId: 'contacts',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'contacts.pages.contactEdit.title',
} as const;

export default routeMeta;
export { routeMeta };
