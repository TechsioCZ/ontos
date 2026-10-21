import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/smlouvy',
  descriptionKey: 'legal-agreements.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
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
} as const;

export default routeMeta;
export { routeMeta };
