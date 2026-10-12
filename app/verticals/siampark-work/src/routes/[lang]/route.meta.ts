import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'siampark-work.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'siampark.work.page.siampark-work-home',
    moduleKey: 'siampark.work',
    role: 'page',
  }),
  id: 'siampark-work-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalSiamparkWork',
  moduleId: 'siampark.work',
  namespace: 'siampark-work',
  ownerAppId: 'siampark-work',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'siampark-work.title',
} as const;

export default routeMeta;
export { routeMeta };
