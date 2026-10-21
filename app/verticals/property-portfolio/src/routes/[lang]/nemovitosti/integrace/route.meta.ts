import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/nemovitosti/integrace',
  descriptionKey: 'property-portfolio.pages.integrations.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'property.portfolio.page.integrations',
    moduleKey: 'property.portfolio',
    role: 'page',
  }),
  id: 'property-portfolio-integrations',
  indexable: false,
  localisedPaths: {
    cs: '/nemovitosti/integrace',
    en: '/nemovitosti/integrace',
  },
  mfBoundaryId: 'verticalPropertyPortfolio',
  moduleId: 'property.portfolio',
  namespace: 'property-portfolio',
  ownerAppId: 'property-portfolio',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'property-portfolio.pages.integrations.title',
} as const;

export default routeMeta;
export { routeMeta };
