import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'siampark-relationships.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'siampark.relationships.page.siampark-relationships-home',
    moduleKey: 'siampark.relationships',
    role: 'page',
  }),
  id: 'siampark-relationships-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalSiamparkRelationships',
  moduleId: 'siampark.relationships',
  namespace: 'siampark-relationships',
  ownerAppId: 'siampark-relationships',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'siampark-relationships.title',
} as const;

export default routeMeta;
export { routeMeta };
