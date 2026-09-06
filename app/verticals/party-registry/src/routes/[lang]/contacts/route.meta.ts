import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/contacts',
  descriptionKey: 'party-registry.pages.contacts.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'party.registry.page.contacts',
    moduleKey: 'party.registry',
    role: 'page',
  }),
  id: 'party-registry-contacts',
  indexable: false,
  localisedPaths: {
    cs: '/contacts',
    en: '/contacts',
  },
  mfBoundaryId: 'verticalPartyRegistry',
  moduleId: 'party.registry',
  namespace: 'party-registry',
  ownerAppId: 'party-registry',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'party-registry.pages.contacts.title',
} as const;

export default routeMeta;
export { routeMeta };
