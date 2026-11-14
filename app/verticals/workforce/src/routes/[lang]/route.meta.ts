import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'demo.workforce.page-workforce-home.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'workforce', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/',
  descriptionKey: 'workforce.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
