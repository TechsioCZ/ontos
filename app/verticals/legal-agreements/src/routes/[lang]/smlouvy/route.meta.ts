import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'legal.agreements.page-records.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'legal-agreements', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/smlouvy',
  descriptionKey: 'legal-agreements.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'legal.agreements.page.records',
    moduleKey: 'legal.agreements',
    role: 'page',
  }),
  id: 'legal-agreements-records',
  indexable: false,
  localisedPaths: {
    cs: '/smlouvy',
    en: '/smlouvy',
  },
  mfBoundaryId: 'verticalLegalAgreements',
  moduleId: 'legal.agreements',
  namespace: 'legal-agreements',
  ownerAppId: 'legal-agreements',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'legal-agreements.pages.records.title',
});

export default routeMeta;
export { routeMeta };
