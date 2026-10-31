import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/prodej/zakaznici',
  descriptionKey: 'party-registry.pages.customers.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'party.registry.page.customers',
    moduleKey: 'party.registry',
    role: 'page',
  }),
  id: 'party-registry-customers',
  indexable: false,
  localisedPaths: {
    cs: '/prodej/zakaznici',
    en: '/prodej/zakaznici',
  },
  mfBoundaryId: 'verticalPartyRegistry',
  moduleId: 'party.registry',
  namespace: 'party-registry',
  ownerAppId: 'party-registry',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'party-registry.pages.customers.title',
} as const;

export default routeMeta;
export { routeMeta };
