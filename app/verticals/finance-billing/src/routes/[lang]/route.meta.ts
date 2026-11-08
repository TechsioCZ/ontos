import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'finance.billing.page-finance-billing-home.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'finance-billing', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/',
  descriptionKey: 'finance-billing.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
