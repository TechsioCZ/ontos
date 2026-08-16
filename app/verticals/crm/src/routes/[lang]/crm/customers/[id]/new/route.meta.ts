import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/crm/customers/:id/new',
  descriptionKey: 'crm.pages.customerCreate.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'crm.core.page.customer-create',
    moduleKey: 'crm.core',
    role: 'page',
  }),
  id: 'crm-customer-create',
  indexable: false,
  localisedPaths: {
    cs: '/crm/customers/:id/new',
    en: '/crm/customers/:id/new',
  },
  mfBoundaryId: 'verticalCrm',
  moduleId: 'crm.core',
  namespace: 'crm',
  ownerAppId: 'crm',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm.pages.customerCreate.title',
} as const;

export default routeMeta;
export { routeMeta };
