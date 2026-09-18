import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'privacy.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'authenticated_principal' },
    entrypointKey: 'privacy.core.page.home',
    moduleKey: 'privacy.core',
    role: 'page',
  }),
  id: 'privacy-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalPrivacy',
  moduleId: 'privacy.core',
  namespace: 'privacy',
  ownerAppId: 'privacy',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'privacy.title',
} as const;

export default routeMeta;
export { routeMeta };
