import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'facility.operations.page-overview.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'facility-operations', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/provoz/prehled',
  descriptionKey: 'facility-operations.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
