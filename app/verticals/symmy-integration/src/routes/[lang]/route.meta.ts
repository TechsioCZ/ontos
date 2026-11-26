import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  canonicalPath: '/',
  descriptionKey: 'symmy-integration.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'authenticated_principal' },
    entrypointKey: 'integration.symmy.page.home',
    moduleKey: 'integration.symmy',
    role: 'page',
  }),
  id: 'symmy-integration-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalSymmyIntegration',
  moduleId: 'integration.symmy',
  namespace: 'symmy-integration',
  ownerAppId: 'symmy-integration',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'symmy-integration.title',
});

export default routeMeta;
export { routeMeta };
