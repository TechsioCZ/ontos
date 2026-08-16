import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/crm/customers/:id/contacts/:contactId',
  descriptionKey: 'crm.pages.contactDetail.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'crm.core.page.contact-detail',
    moduleKey: 'crm.core',
    role: 'page',
  }),
  id: 'crm-contact-detail',
  indexable: false,
  localisedPaths: {
    cs: '/crm/customers/:id/contacts/:contactId',
    en: '/crm/customers/:id/contacts/:contactId',
  },
  mfBoundaryId: 'verticalCrm',
  moduleId: 'crm.core',
  namespace: 'crm',
  ownerAppId: 'crm',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm.pages.contactDetail.title',
} as const;

export default routeMeta;
export { routeMeta };
