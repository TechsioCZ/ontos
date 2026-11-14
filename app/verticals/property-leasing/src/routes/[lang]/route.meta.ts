import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'property.leasing.page-property-leasing-home.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'property-leasing', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/',
  descriptionKey: 'property-leasing.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'property.leasing.page.property-leasing-home',
    moduleKey: 'property.leasing',
    role: 'page',
  }),
  id: 'property-leasing-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalPropertyLeasing',
  moduleId: 'property.leasing',
  namespace: 'property-leasing',
  ownerAppId: 'property-leasing',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'property-leasing.title',
});

export default routeMeta;
export { routeMeta };
