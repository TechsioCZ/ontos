import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'siampark-agreements.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'siampark.agreements.page.siampark-agreements-home',
    moduleKey: 'siampark.agreements',
    role: 'page',
  }),
  id: 'siampark-agreements-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalSiamparkAgreements',
  moduleId: 'siampark.agreements',
  namespace: 'siampark-agreements',
  ownerAppId: 'siampark-agreements',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'siampark-agreements.title',
} as const;

export default routeMeta;
export { routeMeta };
