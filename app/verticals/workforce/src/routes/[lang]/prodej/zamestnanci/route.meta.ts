import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'demo.workforce.page-records.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'workforce', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/prodej/zamestnanci',
  descriptionKey: 'workforce.pages.employees.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
  titleKey: 'workforce.pages.employees.title',
});

export default routeMeta;
export { routeMeta };
