import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'workforce.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'demo.workforce.page.workforce-home',
    moduleKey: 'demo.workforce',
    role: 'page',
  }),
  id: 'workforce-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalWorkforce',
  moduleId: 'demo.workforce',
  namespace: 'workforce',
  ownerAppId: 'workforce',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'workforce.title',
} as const;

export default routeMeta;
export { routeMeta };
