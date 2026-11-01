import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/prodej/eshopy/trhy/:marketId',
  descriptionKey: 'commerce-market-catalog.pages.marketDetail.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
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
} as const;

export default routeMeta;
export { routeMeta };
