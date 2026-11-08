import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'facility.operations.page-purchasing.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'facility-operations', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/provoz/nakupy',
  descriptionKey: 'facility-operations.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
