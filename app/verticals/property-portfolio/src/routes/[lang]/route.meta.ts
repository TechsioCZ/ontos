import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'property-portfolio.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'property.portfolio.page.property-portfolio-home',
    moduleKey: 'property.portfolio',
    role: 'page',
  }),
  id: 'property-portfolio-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalPropertyPortfolio',
  moduleId: 'property.portfolio',
  namespace: 'property-portfolio',
  ownerAppId: 'property-portfolio',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'property-portfolio.title',
} as const;

export default routeMeta;
export { routeMeta };
