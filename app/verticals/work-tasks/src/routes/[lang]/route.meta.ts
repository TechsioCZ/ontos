import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'work.tasks.page-work-tasks-home.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'work-tasks', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/',
  descriptionKey: 'work-tasks.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
