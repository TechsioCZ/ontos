import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/siampark/work',
  descriptionKey: 'siampark-work.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'siampark.work.page.records',
    moduleKey: 'siampark.work',
    role: 'page',
  }),
  id: 'siampark-work-records',
  indexable: false,
  localisedPaths: {
    cs: '/siampark/work',
    en: '/siampark/work',
  },
  mfBoundaryId: 'verticalSiamparkWork',
  moduleId: 'siampark.work',
  namespace: 'siampark-work',
  ownerAppId: 'siampark-work',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'siampark-work.pages.records.title',
} as const;

export default routeMeta;
export { routeMeta };
