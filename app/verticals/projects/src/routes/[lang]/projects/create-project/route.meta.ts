import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  canonicalPath: '/projects/create-project',
  descriptionKey: 'projects.pages.createProject.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'authenticated_principal' },
    entrypointKey: 'projects.core.page.create-project',
    moduleKey: 'projects.core',
    role: 'page',
  }),
  id: 'projects-create-project',
  indexable: false,
  localisedPaths: {
    cs: '/projects/create-project',
    en: '/projects/create-project',
  },
  mfBoundaryId: 'verticalProjects',
  moduleId: 'projects.core',
  namespace: 'projects',
  ownerAppId: 'projects',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'projects.pages.createProject.title',
});

export default routeMeta;
export { routeMeta };
