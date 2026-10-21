import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'work-tasks.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'work.tasks.page.work-tasks-home',
    moduleKey: 'work.tasks',
    role: 'page',
  }),
  id: 'work-tasks-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalWorkTasks',
  moduleId: 'work.tasks',
  namespace: 'work-tasks',
  ownerAppId: 'work-tasks',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'work-tasks.title',
} as const;

export default routeMeta;
export { routeMeta };
