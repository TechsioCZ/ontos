import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'property.portfolio.page-overview.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'property-portfolio', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/nemovitosti/prehled',
  descriptionKey: 'property-portfolio.pages.overview.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
