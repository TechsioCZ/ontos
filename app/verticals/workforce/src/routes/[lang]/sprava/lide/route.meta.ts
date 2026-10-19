import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/sprava/lide',
  descriptionKey: 'workforce.pages.people.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'demo.workforce.page.people',
    moduleKey: 'demo.workforce',
    role: 'page',
  }),
  id: 'workforce-people',
  indexable: false,
  localisedPaths: {
    cs: '/sprava/lide',
    en: '/sprava/lide',
  },
  mfBoundaryId: 'verticalWorkforce',
  moduleId: 'demo.workforce',
  namespace: 'workforce',
  ownerAppId: 'workforce',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'workforce.pages.people.title',
} as const;

export default routeMeta;
export { routeMeta };
