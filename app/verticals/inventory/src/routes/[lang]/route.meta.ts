import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'inventory.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'authenticated_principal' },
    entrypointKey: 'commerce.inventory.page.inventory-home',
    moduleKey: 'commerce.inventory',
    role: 'page',
  }),
  id: 'inventory-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalInventory',
  moduleId: 'commerce.inventory',
  namespace: 'inventory',
  ownerAppId: 'inventory',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'inventory.title',
} as const;

export default routeMeta;
export { routeMeta };
