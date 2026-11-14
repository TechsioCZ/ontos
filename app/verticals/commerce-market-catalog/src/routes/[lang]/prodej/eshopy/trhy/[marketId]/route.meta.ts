import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'commerce.market-catalog.market-detail.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'markets', level: 'manage' },
    risk: 'sensitive',
    selectors: [],
  },
  canonicalPath: '/prodej/eshopy/trhy/:marketId',
  descriptionKey: 'commerce-market-catalog.pages.marketDetail.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'commerce.market-catalog.page.market-detail',
    moduleKey: 'commerce.market-catalog',
    role: 'page',
  }),
  id: 'commerce-market-catalog-market-detail',
  indexable: false,
  localisedPaths: {
    cs: '/prodej/eshopy/trhy/:marketId',
    en: '/prodej/eshopy/trhy/:marketId',
  },
  mfBoundaryId: 'verticalCommerceMarketCatalog',
  moduleId: 'commerce.market-catalog',
  namespace: 'commerce-market-catalog',
  ownerAppId: 'commerce-market-catalog',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'commerce-market-catalog.pages.marketDetail.title',
});

export default routeMeta;
export { routeMeta };
