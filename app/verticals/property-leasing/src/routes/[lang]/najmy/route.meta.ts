import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'property.leasing.page-records.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'property-leasing', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/najmy',
  descriptionKey: 'property-leasing.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'property.leasing.page.records',
    moduleKey: 'property.leasing',
    role: 'page',
  }),
  id: 'property-leasing-records',
  indexable: false,
  localisedPaths: {
    cs: '/najmy',
    en: '/najmy',
  },
  mfBoundaryId: 'verticalPropertyLeasing',
  moduleId: 'property.leasing',
  namespace: 'property-leasing',
  ownerAppId: 'property-leasing',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'property-leasing.pages.records.title',
});

export default routeMeta;
export { routeMeta };
