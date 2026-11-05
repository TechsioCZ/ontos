import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'commerce.assortment.home.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'configuration', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/',
  descriptionKey: 'assortment.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'commerce.assortment.page.assortment-home',
    moduleKey: 'commerce.assortment',
    role: 'page',
  }),
  id: 'assortment-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalAssortment',
  moduleId: 'commerce.assortment',
  namespace: 'assortment',
  ownerAppId: 'assortment',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'assortment.title',
});

export default routeMeta;
export { routeMeta };
