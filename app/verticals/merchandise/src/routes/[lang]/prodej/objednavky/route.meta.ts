import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'demo.merchandise.page-orders.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'merchandise', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/prodej/objednavky',
  descriptionKey: 'merchandise.pages.orders.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'demo.merchandise.page.orders',
    moduleKey: 'demo.merchandise',
    role: 'page',
  }),
  id: 'merchandise-orders',
  indexable: false,
  localisedPaths: {
    cs: '/prodej/objednavky',
    en: '/prodej/objednavky',
  },
  mfBoundaryId: 'verticalMerchandise',
  moduleId: 'demo.merchandise',
  namespace: 'merchandise',
  ownerAppId: 'merchandise',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'merchandise.pages.orders.title',
});

export default routeMeta;
export { routeMeta };
