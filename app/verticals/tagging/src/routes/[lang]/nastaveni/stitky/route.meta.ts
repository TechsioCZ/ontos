import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'demo.tagging.page-records.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'tagging', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/nastaveni/stitky',
  descriptionKey: 'tagging.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
