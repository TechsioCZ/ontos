import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/siampark/relationships',
  descriptionKey: 'siampark-relationships.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'siampark.relationships.page.records',
    moduleKey: 'siampark.relationships',
    role: 'page',
  }),
  id: 'siampark-relationships-records',
  indexable: false,
  localisedPaths: {
    cs: '/siampark/relationships',
    en: '/siampark/relationships',
  },
  mfBoundaryId: 'verticalSiamparkRelationships',
  moduleId: 'siampark.relationships',
  namespace: 'siampark-relationships',
  ownerAppId: 'siampark-relationships',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'siampark-relationships.pages.records.title',
} as const;

export default routeMeta;
export { routeMeta };
