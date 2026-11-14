import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'legal.agreements.page-legal-agreements-home.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'legal-agreements', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/',
  descriptionKey: 'legal-agreements.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'legal.agreements.page.legal-agreements-home',
    moduleKey: 'legal.agreements',
    role: 'page',
  }),
  id: 'legal-agreements-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalLegalAgreements',
  moduleId: 'legal.agreements',
  namespace: 'legal-agreements',
  ownerAppId: 'legal-agreements',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'legal-agreements.title',
});

export default routeMeta;
export { routeMeta };
