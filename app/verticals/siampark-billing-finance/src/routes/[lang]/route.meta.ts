import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'siampark-billing-finance.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'siampark.billing-finance.page.siampark-billing-finance-home',
    moduleKey: 'siampark.billing-finance',
    role: 'page',
  }),
  id: 'siampark-billing-finance-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalSiamparkBillingFinance',
  moduleId: 'siampark.billing-finance',
  namespace: 'siampark-billing-finance',
  ownerAppId: 'siampark-billing-finance',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'siampark-billing-finance.title',
} as const;

export default routeMeta;
export { routeMeta };
