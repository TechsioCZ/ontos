import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/provoz/nakupy',
  descriptionKey: 'facility-operations.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'facility.operations.read_all' },
    entrypointKey: 'facility.operations.page.purchasing',
    moduleKey: 'facility.operations',
    role: 'page',
  }),
  id: 'facility-operations-purchasing',
  indexable: false,
  localisedPaths: {
    cs: '/provoz/nakupy',
    en: '/provoz/nakupy',
  },
  mfBoundaryId: 'verticalFacilityOperations',
  moduleId: 'facility.operations',
  namespace: 'facility-operations',
  ownerAppId: 'facility-operations',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'facility-operations.purchasing.title',
} as const;

export default routeMeta;
export { routeMeta };
