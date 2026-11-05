import { defineSystemModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  canonicalPath: '/*',
  descriptionKey: 'shell.moduleTarget.seoDescription',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'authenticated_principal' },
    entrypointKey: 'shell-super-app.page.canonical-module-target',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-canonical-module-target',
  indexable: false,
  localisedPaths: {
    cs: '/*',
    en: '/*',
  },
  mfBoundaryId: 'shellSuperApp',
  namespace: 'shell',
  ownerAppId: 'shell-super-app',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'shell.moduleTarget.title',
});

export default routeMeta;
export { routeMeta };
