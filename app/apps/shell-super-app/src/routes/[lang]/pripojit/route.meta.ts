import { defineSystemModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/pripojit',
  descriptionKey: 'shell.connect.seoDescription',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'authenticated_principal' },
    entrypointKey: 'shell-super-app.page.connect',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-connect',
  indexable: false,
  localisedPaths: {
    cs: '/pripojit',
    en: '/pripojit',
  },
  mfBoundaryId: 'shellSuperApp',
  namespace: 'shell',
  ownerAppId: 'shell-super-app',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'shell.connect.pageTitle',
} as const;

export default routeMeta;
export { routeMeta };
