import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'commerce.market-catalog.eshops.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'markets', level: 'basic' },
    risk: 'sensitive',
    selectors: [],
  },
  canonicalPath: '/prodej/eshopy',
  descriptionKey: 'commerce-market-catalog.pages.eshops.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
