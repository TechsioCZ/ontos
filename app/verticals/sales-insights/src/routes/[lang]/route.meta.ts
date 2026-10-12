import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'sales-insights.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
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
} as const;

export default routeMeta;
export { routeMeta };
