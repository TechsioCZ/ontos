import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/najmy',
  descriptionKey: 'property-leasing.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
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
} as const;

export default routeMeta;
export { routeMeta };
