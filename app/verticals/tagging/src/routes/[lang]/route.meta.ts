import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'demo.tagging.page-tagging-home.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'tagging', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/',
  descriptionKey: 'tagging.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'demo.tagging.page.tagging-home',
    moduleKey: 'demo.tagging',
    role: 'page',
  }),
  id: 'tagging-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalTagging',
  moduleId: 'demo.tagging',
  namespace: 'tagging',
  ownerAppId: 'tagging',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'tagging.title',
});

export default routeMeta;
export { routeMeta };
