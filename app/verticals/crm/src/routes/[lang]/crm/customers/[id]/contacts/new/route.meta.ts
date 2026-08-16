import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/crm/customers/:id/contacts/new',
  descriptionKey: 'crm.pages.contactCreate.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'crm.core.page.contact-create',
    moduleKey: 'crm.core',
    role: 'page',
  }),
  id: 'crm-contact-create',
  indexable: false,
  localisedPaths: {
    cs: '/crm/customers/:id/contacts/new',
    en: '/crm/customers/:id/contacts/new',
  },
  mfBoundaryId: 'verticalCrm',
  moduleId: 'crm.core',
  namespace: 'crm',
  ownerAppId: 'crm',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm.pages.contactCreate.title',
} as const;

export default routeMeta;
export { routeMeta };
