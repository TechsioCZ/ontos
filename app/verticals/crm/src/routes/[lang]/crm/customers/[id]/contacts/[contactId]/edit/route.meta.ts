import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/crm/customers/:id/contacts/:contactId/edit',
  descriptionKey: 'crm.pages.contactEdit.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'crm.core.page.contact-edit',
    moduleKey: 'crm.core',
    role: 'page',
  }),
  id: 'crm-contact-edit',
  indexable: false,
  localisedPaths: {
    cs: '/crm/customers/:id/contacts/:contactId/edit',
    en: '/crm/customers/:id/contacts/:contactId/edit',
  },
  mfBoundaryId: 'verticalCrm',
  moduleId: 'crm.core',
  namespace: 'crm',
  ownerAppId: 'crm',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm.pages.contactEdit.title',
} as const;

export default routeMeta;
export { routeMeta };
