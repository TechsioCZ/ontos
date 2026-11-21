import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'commerce.catalog.products.view',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'product', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/katalog/produkty',
  descriptionKey: 'catalog.pages.products.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'commerce.catalog.page.products',
    moduleKey: 'commerce.catalog',
    role: 'page',
  }),
  id: 'catalog-products',
  indexable: false,
  localisedPaths: {
    cs: '/katalog/produkty',
    en: '/katalog/produkty',
  },
  mfBoundaryId: 'verticalCatalog',
  moduleId: 'commerce.catalog',
  namespace: 'catalog',
  ownerAppId: 'catalog',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'catalog.pages.products.title',
});

export default routeMeta;
export { routeMeta };
