import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/contacts',
  descriptionKey: 'contacts.pages.contacts.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'contacts.core.page.contacts',
    moduleKey: 'contacts.core',
    role: 'page',
  }),
  id: 'contacts-contacts',
  indexable: false,
  localisedPaths: {
    cs: '/contacts',
    en: '/contacts',
  },
  mfBoundaryId: 'verticalContacts',
  moduleId: 'contacts.core',
  namespace: 'contacts',
  ownerAppId: 'contacts',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'contacts.pages.contacts.title',
} as const;

export default routeMeta;
export { routeMeta };
