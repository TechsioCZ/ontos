import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'property.portfolio.page-records.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'property-portfolio', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/nemovitosti',
  descriptionKey: 'property-portfolio.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
