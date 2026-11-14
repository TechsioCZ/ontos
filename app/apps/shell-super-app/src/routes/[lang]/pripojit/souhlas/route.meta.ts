import { defineSystemModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/pripojit/souhlas',
  descriptionKey: 'shell.connect.consent.seoDescription',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'authenticated_principal' },
    entrypointKey: 'shell-super-app.page.connect-consent',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-connect-consent',
  indexable: false,
  localisedPaths: {
    cs: '/pripojit/souhlas',
    en: '/pripojit/souhlas',
  },
  mfBoundaryId: 'shellSuperApp',
  namespace: 'shell',
  ownerAppId: 'shell-super-app',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'shell.connect.consent.pageTitle',
} as const;

export default routeMeta;
export { routeMeta };
