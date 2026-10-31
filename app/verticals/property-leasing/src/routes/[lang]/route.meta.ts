import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'property-leasing.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
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
} as const;

export default routeMeta;
export { routeMeta };
