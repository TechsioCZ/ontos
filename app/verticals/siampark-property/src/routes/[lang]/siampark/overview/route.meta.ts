import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/siampark/overview',
  descriptionKey: 'siampark-property.pages.overview.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'siampark.property.page.overview',
    moduleKey: 'siampark.property',
    role: 'page',
  }),
  id: 'siampark-property-overview',
  indexable: false,
  localisedPaths: {
    cs: '/siampark/overview',
    en: '/siampark/overview',
  },
  mfBoundaryId: 'verticalSiamparkProperty',
  moduleId: 'siampark.property',
  namespace: 'siampark-property',
  ownerAppId: 'siampark-property',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'siampark-property.pages.overview.title',
} as const;

export default routeMeta;
export { routeMeta };
