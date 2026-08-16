import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/crm/customers/:id',
  descriptionKey: 'crm.pages.customerDetail.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'crm.core.page.customer-detail',
    moduleKey: 'crm.core',
    role: 'page',
  }),
  id: 'crm-customer-detail',
  indexable: false,
  localisedPaths: {
    cs: '/crm/customers/:id',
    en: '/crm/customers/:id',
  },
  mfBoundaryId: 'verticalCrm',
  moduleId: 'crm.core',
  namespace: 'crm',
  ownerAppId: 'crm',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm.pages.customerDetail.title',
} as const;

export default routeMeta;
export { routeMeta };
