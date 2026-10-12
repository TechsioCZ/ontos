import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'siampark-occupancy.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'siampark.occupancy.page.siampark-occupancy-home',
    moduleKey: 'siampark.occupancy',
    role: 'page',
  }),
  id: 'siampark-occupancy-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalSiamparkOccupancy',
  moduleId: 'siampark.occupancy',
  namespace: 'siampark-occupancy',
  ownerAppId: 'siampark-occupancy',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'siampark-occupancy.title',
} as const;

export default routeMeta;
export { routeMeta };
