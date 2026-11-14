import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'demo.sales-pipeline.page-sales-pipeline-home.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'sales-pipeline', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/',
  descriptionKey: 'sales-pipeline.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'demo.sales-pipeline.page.sales-pipeline-home',
    moduleKey: 'demo.sales-pipeline',
    role: 'page',
  }),
  id: 'sales-pipeline-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalSalesPipeline',
  moduleId: 'demo.sales-pipeline',
  namespace: 'sales-pipeline',
  ownerAppId: 'sales-pipeline',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'sales-pipeline.title',
});

export default routeMeta;
export { routeMeta };
