import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/provoz/bezpecnost',
  descriptionKey: 'facility-operations.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'facility.operations.read_all' },
    entrypointKey: 'facility.operations.page.security',
    moduleKey: 'facility.operations',
    role: 'page',
  }),
  id: 'facility-operations-security',
  indexable: false,
  localisedPaths: {
    cs: '/provoz/bezpecnost',
    en: '/provoz/bezpecnost',
  },
  mfBoundaryId: 'verticalFacilityOperations',
  moduleId: 'facility.operations',
  namespace: 'facility-operations',
  ownerAppId: 'facility-operations',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'facility-operations.security.title',
} as const;

export default routeMeta;
export { routeMeta };
