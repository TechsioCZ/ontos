import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/provoz/dokumenty',
  descriptionKey: 'facility-operations.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'facility.operations.read_all' },
    entrypointKey: 'facility.operations.page.documents',
    moduleKey: 'facility.operations',
    role: 'page',
  }),
  id: 'facility-operations-documents',
  indexable: false,
  localisedPaths: {
    cs: '/provoz/dokumenty',
    en: '/provoz/dokumenty',
  },
  mfBoundaryId: 'verticalFacilityOperations',
  moduleId: 'facility.operations',
  namespace: 'facility-operations',
  ownerAppId: 'facility-operations',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'facility-operations.documents.title',
} as const;

export default routeMeta;
export { routeMeta };
