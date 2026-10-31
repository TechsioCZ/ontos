import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/provoz/meridla',
  descriptionKey: 'facility-operations.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'facility.operations.page.meters',
    moduleKey: 'facility.operations',
    role: 'page',
  }),
  id: 'facility-operations-meters',
  indexable: false,
  localisedPaths: {
    cs: '/provoz/meridla',
    en: '/provoz/meridla',
  },
  mfBoundaryId: 'verticalFacilityOperations',
  moduleId: 'facility.operations',
  namespace: 'facility-operations',
  ownerAppId: 'facility-operations',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'facility-operations.meters.title',
} as const;

export default routeMeta;
export { routeMeta };
