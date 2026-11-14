import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/prodej/zakaznici/:id',
  descriptionKey: 'party-registry.pages.customerDetail.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'party.registry.page.customer-detail',
    moduleKey: 'party.registry',
    role: 'page',
  }),
  id: 'party-registry-customer-detail',
  indexable: false,
  localisedPaths: {
    cs: '/prodej/zakaznici/:id',
    en: '/prodej/zakaznici/:id',
  },
  mfBoundaryId: 'verticalPartyRegistry',
  moduleId: 'party.registry',
  namespace: 'party-registry',
  ownerAppId: 'party-registry',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'party-registry.pages.customerDetail.title',
} as const;

export default routeMeta;
export { routeMeta };
