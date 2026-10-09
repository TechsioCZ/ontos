import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'assortment.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'assortment.configuration.read' },
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
} as const;

export default routeMeta;
export { routeMeta };
