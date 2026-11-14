import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'facility.operations.page-meters.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'facility-operations', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/provoz/meridla',
  descriptionKey: 'facility-operations.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
