import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/provoz/agenda',
  descriptionKey: 'facility-operations.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'facility.operations.page.agenda',
    moduleKey: 'facility.operations',
    role: 'page',
  }),
  id: 'facility-operations-agenda',
  indexable: false,
  localisedPaths: {
    cs: '/provoz/agenda',
    en: '/provoz/agenda',
  },
  mfBoundaryId: 'verticalFacilityOperations',
  moduleId: 'facility.operations',
  namespace: 'facility-operations',
  ownerAppId: 'facility-operations',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'facility-operations.agenda.title',
} as const;

export default routeMeta;
export { routeMeta };
