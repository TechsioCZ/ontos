import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/nemovitosti/prehled',
  descriptionKey: 'property-portfolio.pages.overview.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'property.portfolio.page.overview',
    moduleKey: 'property.portfolio',
    role: 'page',
  }),
  id: 'property-portfolio-overview',
  indexable: false,
  localisedPaths: {
    cs: '/nemovitosti/prehled',
    en: '/nemovitosti/prehled',
  },
  mfBoundaryId: 'verticalPropertyPortfolio',
  moduleId: 'property.portfolio',
  namespace: 'property-portfolio',
  ownerAppId: 'property-portfolio',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'property-portfolio.pages.overview.title',
} as const;

export default routeMeta;
export { routeMeta };
