import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/finance',
  descriptionKey: 'finance-billing.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'finance.billing.page.records',
    moduleKey: 'finance.billing',
    role: 'page',
  }),
  id: 'finance-billing-records',
  indexable: false,
  localisedPaths: {
    cs: '/finance',
    en: '/finance',
  },
  mfBoundaryId: 'verticalFinanceBilling',
  moduleId: 'finance.billing',
  namespace: 'finance-billing',
  ownerAppId: 'finance-billing',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'finance-billing.pages.records.title',
} as const;

export default routeMeta;
export { routeMeta };
