import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'commerce.market-catalog.home.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'markets', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/',
  descriptionKey: 'commerce-market-catalog.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'commerce.market-catalog.page.home',
    moduleKey: 'commerce.market-catalog',
    role: 'page',
  }),
  id: 'commerce-market-catalog-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalCommerceMarketCatalog',
  moduleId: 'commerce.market-catalog',
  namespace: 'commerce-market-catalog',
  ownerAppId: 'commerce-market-catalog',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'commerce-market-catalog.title',
});

export default routeMeta;
export { routeMeta };
