import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'demo.sales-insights.page-records.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'sales-insights', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/prehledy/statistiky',
  descriptionKey: 'sales-insights.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
