import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/provoz/produkty/:id',
  descriptionKey: 'merchandise.pages.productDetail.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'demo.merchandise.read_all' },
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
} as const;

export default routeMeta;
export { routeMeta };
