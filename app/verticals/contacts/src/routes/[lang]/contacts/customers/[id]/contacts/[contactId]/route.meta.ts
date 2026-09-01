import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/contacts/customers/:id/contacts/:contactId',
  descriptionKey: 'contacts.pages.contactDetail.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'contacts.core.page.contact-detail',
    moduleKey: 'contacts.core',
    role: 'page',
  }),
  id: 'contacts-contact-detail',
  indexable: false,
  localisedPaths: {
    cs: '/contacts/customers/:id/contacts/:contactId',
    en: '/contacts/customers/:id/contacts/:contactId',
  },
  mfBoundaryId: 'verticalContacts',
  moduleId: 'contacts.core',
  namespace: 'contacts',
  ownerAppId: 'contacts',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'contacts.pages.contactDetail.title',
} as const;

export default routeMeta;
export { routeMeta };
