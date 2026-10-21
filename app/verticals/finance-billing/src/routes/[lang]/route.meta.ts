import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'finance-billing.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'finance.billing.page.finance-billing-home',
    moduleKey: 'finance.billing',
    role: 'page',
  }),
  id: 'finance-billing-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalFinanceBilling',
  moduleId: 'finance.billing',
  namespace: 'finance-billing',
  ownerAppId: 'finance-billing',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'finance-billing.title',
} as const;

export default routeMeta;
export { routeMeta };
