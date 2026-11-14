import { defineSystemModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

export const routeMeta = {
  canonicalPath: '/set-password',
  descriptionKey: 'shell.invitation.description',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'public' },
    entrypointKey: 'shell-super-app.page.set-password',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-set-password',
  indexable: false,
  localisedPaths: { cs: '/set-password', en: '/set-password' },
  mfBoundaryId: 'shellSuperApp',
  namespace: 'shell',
  ownerAppId: 'shell-super-app',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'shell.invitation.title',
} as const;
export default routeMeta;
