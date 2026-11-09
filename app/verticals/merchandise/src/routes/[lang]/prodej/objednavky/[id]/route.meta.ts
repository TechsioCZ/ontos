import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'demo.merchandise.page-order-detail.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'merchandise', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/prodej/objednavky/:id',
  descriptionKey: 'merchandise.pages.orderDetail.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'demo.merchandise.page.order-detail',
    moduleKey: 'demo.merchandise',
    role: 'page',
  }),
  id: 'merchandise-order-detail',
  indexable: false,
  localisedPaths: {
    cs: '/prodej/objednavky/:id',
    en: '/prodej/objednavky/:id',
  },
  mfBoundaryId: 'verticalMerchandise',
  moduleId: 'demo.merchandise',
  namespace: 'merchandise',
  ownerAppId: 'merchandise',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'merchandise.pages.orderDetail.title',
});

export default routeMeta;
export { routeMeta };
