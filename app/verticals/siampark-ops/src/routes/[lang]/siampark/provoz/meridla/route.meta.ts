import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/siampark/provoz/meridla',
  descriptionKey: 'siampark-ops.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'demo.siampark-ops.page.meters',
    moduleKey: 'demo.siampark-ops',
    role: 'page',
  }),
  id: 'siampark-ops-meters',
  indexable: false,
  localisedPaths: {
    cs: '/siampark/provoz/meridla',
    en: '/siampark/provoz/meridla',
  },
  mfBoundaryId: 'verticalSiamparkOps',
  moduleId: 'demo.siampark-ops',
  namespace: 'siampark-ops',
  ownerAppId: 'siampark-ops',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'siampark-ops.meters.title',
} as const;

export default routeMeta;
export { routeMeta };
