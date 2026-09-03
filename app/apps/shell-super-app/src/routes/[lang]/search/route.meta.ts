import { defineSystemModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/search',
  descriptionKey: 'shell.search.seoDescription',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'authenticated_principal' },
    entrypointKey: 'shell-super-app.page.search',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-search',
  indexable: false,
  localisedPaths: { cs: '/hledat', en: '/search' },
  mfBoundaryId: 'shellSuperApp',
  namespace: 'shell',
  ownerAppId: 'shell-super-app',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'shell.search.title',
} as const;

export default routeMeta;
export { routeMeta };
