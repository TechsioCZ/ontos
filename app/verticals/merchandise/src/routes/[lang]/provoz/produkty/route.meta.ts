import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'demo.merchandise.page-products.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'merchandise', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/provoz/produkty',
  descriptionKey: 'merchandise.pages.products.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'demo.merchandise.page.products',
    moduleKey: 'demo.merchandise',
    role: 'page',
  }),
  id: 'merchandise-records',
  indexable: false,
  localisedPaths: {
    cs: '/provoz/produkty',
    en: '/provoz/produkty',
  },
  mfBoundaryId: 'verticalMerchandise',
  moduleId: 'demo.merchandise',
  namespace: 'merchandise',
  ownerAppId: 'merchandise',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'merchandise.pages.products.title',
});

export default routeMeta;
export { routeMeta };
