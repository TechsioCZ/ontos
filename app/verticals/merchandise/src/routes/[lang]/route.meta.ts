import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'demo.merchandise.page-merchandise-home.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'merchandise', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/',
  descriptionKey: 'merchandise.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'demo.merchandise.page.merchandise-home',
    moduleKey: 'demo.merchandise',
    role: 'page',
  }),
  id: 'merchandise-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalMerchandise',
  moduleId: 'demo.merchandise',
  namespace: 'merchandise',
  ownerAppId: 'merchandise',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'merchandise.title',
});

export default routeMeta;
export { routeMeta };
