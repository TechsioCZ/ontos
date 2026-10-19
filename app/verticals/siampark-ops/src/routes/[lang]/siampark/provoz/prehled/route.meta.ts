import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/siampark/provoz/prehled',
  descriptionKey: 'siampark-ops.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'demo.siampark-ops.page.overview',
    moduleKey: 'demo.siampark-ops',
    role: 'page',
  }),
  id: 'siampark-ops-overview',
  indexable: false,
  localisedPaths: {
    cs: '/siampark/provoz/prehled',
    en: '/siampark/provoz/prehled',
  },
  mfBoundaryId: 'verticalSiamparkOps',
  moduleId: 'demo.siampark-ops',
  namespace: 'siampark-ops',
  ownerAppId: 'siampark-ops',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'siampark-ops.agenda.overview.title',
} as const;

export default routeMeta;
export { routeMeta };
