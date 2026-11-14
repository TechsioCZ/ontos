import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'demo.sales-pipeline.page-records.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'sales-pipeline', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/prodej/prilezitosti',
  descriptionKey: 'sales-pipeline.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'demo.sales-pipeline.page.records',
    moduleKey: 'demo.sales-pipeline',
    role: 'page',
  }),
  id: 'sales-pipeline-records',
  indexable: false,
  localisedPaths: {
    cs: '/prodej/prilezitosti',
    en: '/prodej/prilezitosti',
  },
  mfBoundaryId: 'verticalSalesPipeline',
  moduleId: 'demo.sales-pipeline',
  namespace: 'sales-pipeline',
  ownerAppId: 'sales-pipeline',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'sales-pipeline.pages.records.title',
});

export default routeMeta;
export { routeMeta };
