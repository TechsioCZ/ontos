import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'demo.merchandise.page-product-detail.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'merchandise', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/provoz/produkty/:id',
  descriptionKey: 'merchandise.pages.productDetail.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'demo.merchandise.page.product-detail',
    moduleKey: 'demo.merchandise',
    role: 'page',
  }),
  id: 'merchandise-product-detail',
  indexable: false,
  localisedPaths: {
    cs: '/provoz/produkty/:id',
    en: '/provoz/produkty/:id',
  },
  mfBoundaryId: 'verticalMerchandise',
  moduleId: 'demo.merchandise',
  namespace: 'merchandise',
  ownerAppId: 'merchandise',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'merchandise.pages.productDetail.title',
});

export default routeMeta;
export { routeMeta };
