import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/prodej/objednavky',
  descriptionKey: 'merchandise.pages.orders.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
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
} as const;

export default routeMeta;
export { routeMeta };
