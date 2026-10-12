import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'siampark-property.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'siampark.property.page.siampark-property-home',
    moduleKey: 'siampark.property',
    role: 'page',
  }),
  id: 'siampark-property-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalSiamparkProperty',
  moduleId: 'siampark.property',
  namespace: 'siampark-property',
  ownerAppId: 'siampark-property',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'siampark-property.title',
} as const;

export default routeMeta;
export { routeMeta };
