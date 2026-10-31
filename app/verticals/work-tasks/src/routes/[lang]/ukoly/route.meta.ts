import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/ukoly',
  descriptionKey: 'work-tasks.pages.records.pageDescription',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'work.tasks.page.records',
    moduleKey: 'work.tasks',
    role: 'page',
  }),
  id: 'work-tasks-records',
  indexable: false,
  localisedPaths: {
    cs: '/ukoly',
    en: '/ukoly',
  },
  mfBoundaryId: 'verticalWorkTasks',
  moduleId: 'work.tasks',
  namespace: 'work-tasks',
  ownerAppId: 'work-tasks',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'work-tasks.pages.records.title',
} as const;

export default routeMeta;
export { routeMeta };
