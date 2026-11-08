import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'facility.operations.page-documents.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'facility-operations', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/provoz/dokumenty',
  descriptionKey: 'facility-operations.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
