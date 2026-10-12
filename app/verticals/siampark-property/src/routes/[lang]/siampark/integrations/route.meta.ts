import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/siampark/integrations',
  descriptionKey: 'siampark-property.pages.integrations.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'siampark.property.page.integrations',
    moduleKey: 'siampark.property',
    role: 'page',
  }),
  id: 'siampark-property-integrations',
  indexable: false,
  localisedPaths: {
    cs: '/siampark/integrations',
    en: '/siampark/integrations',
  },
  mfBoundaryId: 'verticalSiamparkProperty',
  moduleId: 'siampark.property',
  namespace: 'siampark-property',
  ownerAppId: 'siampark-property',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'siampark-property.pages.integrations.title',
} as const;

export default routeMeta;
export { routeMeta };
