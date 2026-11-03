import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/prodej/strany/:partyId',
  descriptionKey: 'party-registry.pages.partyIdentity.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'party.registry.page.party-identity',
    moduleKey: 'party.registry',
    role: 'page',
  }),
  id: 'party-registry-party-identity',
  indexable: false,
  localisedPaths: {
    cs: '/prodej/strany/:partyId',
    en: '/prodej/strany/:partyId',
  },
  mfBoundaryId: 'verticalPartyRegistry',
  moduleId: 'party.registry',
  namespace: 'party-registry',
  ownerAppId: 'party-registry',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'party-registry.pages.partyIdentity.title',
} as const;

export default routeMeta;
export { routeMeta };
