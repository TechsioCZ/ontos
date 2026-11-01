import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/prodej/eshopy',
  descriptionKey: 'commerce-market-catalog.pages.eshops.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'commerce.market-catalog.page.eshops',
    moduleKey: 'commerce.market-catalog',
    role: 'page',
  }),
  id: 'commerce-market-catalog-eshops',
  indexable: false,
  localisedPaths: {
    cs: '/prodej/eshopy',
    en: '/prodej/eshopy',
  },
  mfBoundaryId: 'verticalCommerceMarketCatalog',
  moduleId: 'commerce.market-catalog',
  namespace: 'commerce-market-catalog',
  ownerAppId: 'commerce-market-catalog',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'commerce-market-catalog.pages.eshops.title',
} as const;

export default routeMeta;
export { routeMeta };
