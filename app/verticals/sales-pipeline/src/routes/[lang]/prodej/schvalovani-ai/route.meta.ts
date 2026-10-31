import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/prodej/schvalovani-ai',
  descriptionKey: 'sales-pipeline.pages.ai.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'demo.sales_pipeline.write_all' },
    entrypointKey: 'demo.sales-pipeline.page.ai',
    moduleKey: 'demo.sales-pipeline',
    role: 'page',
  }),
  id: 'sales-pipeline-ai',
  indexable: false,
  localisedPaths: {
    cs: '/prodej/schvalovani-ai',
    en: '/prodej/schvalovani-ai',
  },
  mfBoundaryId: 'verticalSalesPipeline',
  moduleId: 'demo.sales-pipeline',
  namespace: 'sales-pipeline',
  ownerAppId: 'sales-pipeline',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'sales-pipeline.pages.ai.title',
} as const;

export default routeMeta;
export { routeMeta };
