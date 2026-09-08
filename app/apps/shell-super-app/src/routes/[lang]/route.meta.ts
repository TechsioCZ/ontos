import { defineSystemModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'shell.seo.description',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'authenticated_principal' },
    entrypointKey: 'shell-super-app.page.home',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'shellSuperApp',
  namespace: 'shell',
  ownerAppId: 'shell-super-app',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'shell.title',
} as const;

export default routeMeta;
export { routeMeta };
