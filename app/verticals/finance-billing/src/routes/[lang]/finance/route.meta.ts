import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'finance.billing.page-records.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'finance-billing', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/finance',
  descriptionKey: 'finance-billing.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
