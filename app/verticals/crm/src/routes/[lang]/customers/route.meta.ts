import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/customers',
  descriptionKey: 'crm.pages.customers.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'crm.core.page.customers',
    moduleKey: 'crm.core',
    role: 'page',
  }),
  id: 'crm-customers',
  indexable: false,
  localisedPaths: {
    cs: '/customers',
    en: '/customers',
  },
  mfBoundaryId: 'verticalCrm',
  moduleId: 'crm.core',
  namespace: 'crm',
  ownerAppId: 'crm',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm.pages.customers.title',
} as const;

export default routeMeta;
export { routeMeta };
