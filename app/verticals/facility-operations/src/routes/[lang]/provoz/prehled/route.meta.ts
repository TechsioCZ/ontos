import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/provoz/prehled',
  descriptionKey: 'facility-operations.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'facility.operations.page.overview',
    moduleKey: 'facility.operations',
    role: 'page',
  }),
  id: 'facility-operations-overview',
  indexable: false,
  localisedPaths: {
    cs: '/provoz/prehled',
    en: '/provoz/prehled',
  },
  mfBoundaryId: 'verticalFacilityOperations',
  moduleId: 'facility.operations',
  namespace: 'facility-operations',
  ownerAppId: 'facility-operations',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'facility-operations.agenda.overview.title',
} as const;

export default routeMeta;
export { routeMeta };
