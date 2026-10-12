import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/prehledy/statistiky',
  descriptionKey: 'sales-insights.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'demo.sales-insights.page.records',
    moduleKey: 'demo.sales-insights',
    role: 'page',
  }),
  id: 'sales-insights-records',
  indexable: false,
  localisedPaths: {
    cs: '/prehledy/statistiky',
    en: '/prehledy/statistiky',
  },
  mfBoundaryId: 'verticalSalesInsights',
  moduleId: 'demo.sales-insights',
  namespace: 'sales-insights',
  ownerAppId: 'sales-insights',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'sales-insights.pages.records.title',
} as const;

export default routeMeta;
export { routeMeta };
