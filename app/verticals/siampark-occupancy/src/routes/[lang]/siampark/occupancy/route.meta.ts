import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/siampark/occupancy',
  descriptionKey: 'siampark-occupancy.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'siampark.occupancy.page.records',
    moduleKey: 'siampark.occupancy',
    role: 'page',
  }),
  id: 'siampark-occupancy-records',
  indexable: false,
  localisedPaths: {
    cs: '/siampark/occupancy',
    en: '/siampark/occupancy',
  },
  mfBoundaryId: 'verticalSiamparkOccupancy',
  moduleId: 'siampark.occupancy',
  namespace: 'siampark-occupancy',
  ownerAppId: 'siampark-occupancy',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'siampark-occupancy.pages.records.title',
} as const;

export default routeMeta;
export { routeMeta };
