import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/provoz/produkty',
  descriptionKey: 'merchandise.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'demo.merchandise.page.records',
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
  titleKey: 'merchandise.pages.records.title',
} as const;

export default routeMeta;
export { routeMeta };
