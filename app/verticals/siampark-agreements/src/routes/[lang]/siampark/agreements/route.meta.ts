import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/siampark/agreements',
  descriptionKey: 'siampark-agreements.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'siampark.agreements.page.records',
    moduleKey: 'siampark.agreements',
    role: 'page',
  }),
  id: 'siampark-agreements-records',
  indexable: false,
  localisedPaths: {
    cs: '/siampark/agreements',
    en: '/siampark/agreements',
  },
  mfBoundaryId: 'verticalSiamparkAgreements',
  moduleId: 'siampark.agreements',
  namespace: 'siampark-agreements',
  ownerAppId: 'siampark-agreements',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'siampark-agreements.pages.records.title',
} as const;

export default routeMeta;
export { routeMeta };
