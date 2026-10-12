import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/siampark/properties',
  descriptionKey: 'siampark-property.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'siampark.property.page.records',
    moduleKey: 'siampark.property',
    role: 'page',
  }),
  id: 'siampark-property-records',
  indexable: false,
  localisedPaths: {
    cs: '/siampark/properties',
    en: '/siampark/properties',
  },
  mfBoundaryId: 'verticalSiamparkProperty',
  moduleId: 'siampark.property',
  namespace: 'siampark-property',
  ownerAppId: 'siampark-property',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'siampark-property.pages.records.title',
} as const;

export default routeMeta;
export { routeMeta };
