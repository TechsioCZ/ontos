import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'demo.sales-pipeline.page-ai.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'sales-pipeline', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/prodej/schvalovani-ai',
  descriptionKey: 'sales-pipeline.pages.ai.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
