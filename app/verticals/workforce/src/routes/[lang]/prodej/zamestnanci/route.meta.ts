import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/prodej/zamestnanci',
  descriptionKey: 'workforce.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'demo.workforce.page.records',
    moduleKey: 'demo.workforce',
    role: 'page',
  }),
  id: 'workforce-records',
  indexable: false,
  localisedPaths: {
    cs: '/prodej/zamestnanci',
    en: '/prodej/zamestnanci',
  },
  mfBoundaryId: 'verticalWorkforce',
  moduleId: 'demo.workforce',
  namespace: 'workforce',
  ownerAppId: 'workforce',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'workforce.pages.records.title',
} as const;

export default routeMeta;
export { routeMeta };
