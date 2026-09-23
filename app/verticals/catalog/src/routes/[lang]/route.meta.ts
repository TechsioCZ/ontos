import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'catalog.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'authenticated_principal' },
    entrypointKey: 'commerce.catalog.page.catalog-home',
    moduleKey: 'commerce.catalog',
    role: 'page',
  }),
  id: 'catalog-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalCatalog',
  moduleId: 'commerce.catalog',
  namespace: 'catalog',
  ownerAppId: 'catalog',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'catalog.title',
} as const;

export default routeMeta;
export { routeMeta };
