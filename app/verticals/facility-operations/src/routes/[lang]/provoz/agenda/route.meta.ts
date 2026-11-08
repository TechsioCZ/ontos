import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'facility.operations.page-agenda.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'facility-operations', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/provoz/agenda',
  descriptionKey: 'facility-operations.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
