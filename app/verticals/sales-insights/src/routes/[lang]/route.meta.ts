import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'demo.sales-insights.page-sales-insights-home.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'sales-insights', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/',
  descriptionKey: 'sales-insights.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'demo.sales-insights.page.sales-insights-home',
    moduleKey: 'demo.sales-insights',
    role: 'page',
  }),
  id: 'sales-insights-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalSalesInsights',
  moduleId: 'demo.sales-insights',
  namespace: 'sales-insights',
  ownerAppId: 'sales-insights',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'sales-insights.title',
});

export default routeMeta;
export { routeMeta };
