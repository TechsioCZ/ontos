import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/nastaveni/stitky',
  descriptionKey: 'tagging.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'demo.tagging.page.records',
    moduleKey: 'demo.tagging',
    role: 'page',
  }),
  id: 'tagging-records',
  indexable: false,
  localisedPaths: {
    cs: '/nastaveni/stitky',
    en: '/nastaveni/stitky',
  },
  mfBoundaryId: 'verticalTagging',
  moduleId: 'demo.tagging',
  namespace: 'tagging',
  ownerAppId: 'tagging',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'tagging.pages.records.title',
} as const;

export default routeMeta;
export { routeMeta };
