import { defineSystemModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/profile',
  descriptionKey: 'shell.profile.seoDescription',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'authenticated_principal' },
    entrypointKey: 'shell-super-app.page.profile',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-profile',
  indexable: false,
  localisedPaths: { cs: '/profil', en: '/profile' },
  mfBoundaryId: 'shellSuperApp',
  namespace: 'shell',
  ownerAppId: 'shell-super-app',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'shell.profile.title',
} as const;

export default routeMeta;
export { routeMeta };
