import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'tagging.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
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
} as const;

export default routeMeta;
export { routeMeta };
