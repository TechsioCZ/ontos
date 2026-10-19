import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/siampark/provoz/dokumenty',
  descriptionKey: 'siampark-ops.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'demo.siampark_ops.read_all' },
    entrypointKey: 'demo.siampark-ops.page.documents',
    moduleKey: 'demo.siampark-ops',
    role: 'page',
  }),
  id: 'siampark-ops-documents',
  indexable: false,
  localisedPaths: {
    cs: '/siampark/provoz/dokumenty',
    en: '/siampark/provoz/dokumenty',
  },
  mfBoundaryId: 'verticalSiamparkOps',
  moduleId: 'demo.siampark-ops',
  namespace: 'siampark-ops',
  ownerAppId: 'siampark-ops',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'siampark-ops.documents.title',
} as const;

export default routeMeta;
export { routeMeta };
