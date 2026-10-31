import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'legal-agreements.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
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
} as const;

export default routeMeta;
export { routeMeta };
