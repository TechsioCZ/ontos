import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/provoz/majetek',
  descriptionKey: 'facility-operations.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'facility.operations.read_all' },
    entrypointKey: 'facility.operations.page.assets',
    moduleKey: 'facility.operations',
    role: 'page',
  }),
  id: 'facility-operations-assets',
  indexable: false,
  localisedPaths: {
    cs: '/provoz/majetek',
    en: '/provoz/majetek',
  },
  mfBoundaryId: 'verticalFacilityOperations',
  moduleId: 'facility.operations',
  namespace: 'facility-operations',
  ownerAppId: 'facility-operations',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'facility-operations.assets.title',
} as const;

export default routeMeta;
export { routeMeta };
