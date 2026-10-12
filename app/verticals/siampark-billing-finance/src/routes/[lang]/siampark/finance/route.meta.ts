import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/siampark/finance',
  descriptionKey: 'siampark-billing-finance.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'siampark.billing-finance.page.records',
    moduleKey: 'siampark.billing-finance',
    role: 'page',
  }),
  id: 'siampark-billing-finance-records',
  indexable: false,
  localisedPaths: {
    cs: '/siampark/finance',
    en: '/siampark/finance',
  },
  mfBoundaryId: 'verticalSiamparkBillingFinance',
  moduleId: 'siampark.billing-finance',
  namespace: 'siampark-billing-finance',
  ownerAppId: 'siampark-billing-finance',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'siampark-billing-finance.pages.records.title',
} as const;

export default routeMeta;
export { routeMeta };
