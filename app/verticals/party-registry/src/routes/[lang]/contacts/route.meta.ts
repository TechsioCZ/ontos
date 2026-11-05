import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'party.registry.contacts-page.open',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'parties', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/contacts',
  descriptionKey: 'party-registry.pages.contacts.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
