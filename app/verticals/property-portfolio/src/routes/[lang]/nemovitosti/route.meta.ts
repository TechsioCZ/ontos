import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/nemovitosti',
  descriptionKey: 'property-portfolio.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'property.portfolio.page.records',
    moduleKey: 'property.portfolio',
    role: 'page',
  }),
  id: 'property-portfolio-records',
  indexable: false,
  localisedPaths: {
    cs: '/nemovitosti',
    en: '/nemovitosti',
  },
  mfBoundaryId: 'verticalPropertyPortfolio',
  moduleId: 'property.portfolio',
  namespace: 'property-portfolio',
  ownerAppId: 'property-portfolio',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'property-portfolio.pages.records.title',
} as const;

export default routeMeta;
export { routeMeta };
