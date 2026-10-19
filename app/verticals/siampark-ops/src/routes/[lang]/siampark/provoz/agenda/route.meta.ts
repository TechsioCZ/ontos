import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/siampark/provoz/agenda',
  descriptionKey: 'siampark-ops.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'demo.siampark-ops.page.agenda',
    moduleKey: 'demo.siampark-ops',
    role: 'page',
  }),
  id: 'siampark-ops-agenda',
  indexable: false,
  localisedPaths: {
    cs: '/siampark/provoz/agenda',
    en: '/siampark/provoz/agenda',
  },
  mfBoundaryId: 'verticalSiamparkOps',
  moduleId: 'demo.siampark-ops',
  namespace: 'siampark-ops',
  ownerAppId: 'siampark-ops',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'siampark-ops.agenda.title',
} as const;

export default routeMeta;
export { routeMeta };
