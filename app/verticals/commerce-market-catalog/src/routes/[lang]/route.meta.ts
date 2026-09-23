import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'commerce-market-catalog.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
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
} as const;

export default routeMeta;
export { routeMeta };
