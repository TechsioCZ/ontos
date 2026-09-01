import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/crm/customers',
  descriptionKey: 'crm.pages.customersList.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'crm.core.page.customers-list',
    moduleKey: 'crm.core',
    role: 'page',
  }),
  id: 'crm-customers-list',
  indexable: false,
  localisedPaths: {
    cs: '/crm/customers',
    en: '/crm/customers',
  },
  mfBoundaryId: 'verticalCrm',
  moduleId: 'crm.core',
  namespace: 'crm',
  ownerAppId: 'crm',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm.pages.customersList.title',
} as const;

export default routeMeta;
export { routeMeta };
