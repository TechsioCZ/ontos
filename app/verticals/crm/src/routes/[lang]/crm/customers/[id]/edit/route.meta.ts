import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/crm/customers/:id/edit',
  descriptionKey: 'crm.pages.customerEdit.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'crm.core.page.customer-edit',
    moduleKey: 'crm.core',
    role: 'page',
  }),
  id: 'crm-customer-edit',
  indexable: false,
  localisedPaths: {
    cs: '/crm/customers/:id/edit',
    en: '/crm/customers/:id/edit',
  },
  mfBoundaryId: 'verticalCrm',
  moduleId: 'crm.core',
  namespace: 'crm',
  ownerAppId: 'crm',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm.pages.customerEdit.title',
} as const;

export default routeMeta;
export { routeMeta };
