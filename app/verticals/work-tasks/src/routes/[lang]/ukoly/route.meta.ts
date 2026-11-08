import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'work.tasks.page-records.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'work-tasks', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/ukoly',
  descriptionKey: 'work-tasks.pages.records.pageDescription',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
