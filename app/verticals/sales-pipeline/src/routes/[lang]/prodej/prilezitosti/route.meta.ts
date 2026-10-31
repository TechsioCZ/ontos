import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/prodej/prilezitosti',
  descriptionKey: 'sales-pipeline.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
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
} as const;

export default routeMeta;
export { routeMeta };
