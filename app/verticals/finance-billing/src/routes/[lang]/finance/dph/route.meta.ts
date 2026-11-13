import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'finance.billing.page-vat.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'finance-billing', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/finance/dph',
  descriptionKey: 'finance-billing.pages.vat.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'finance.billing.page.vat',
    moduleKey: 'finance.billing',
    role: 'page',
  }),
  id: 'finance-billing-vat',
  indexable: false,
  localisedPaths: {
    cs: '/finance/dph',
    en: '/finance/dph',
  },
  mfBoundaryId: 'verticalFinanceBilling',
  moduleId: 'finance.billing',
  namespace: 'finance-billing',
  ownerAppId: 'finance-billing',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'finance-billing.pages.vat.title',
});

export default routeMeta;
export { routeMeta };
