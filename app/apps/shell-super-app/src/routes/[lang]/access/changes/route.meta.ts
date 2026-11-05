import { defineSystemModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    admitsAdminSurface: true,
    key: 'shell-super-app.access-changes.page',
    kind: 'admin',
    modes: ['run'],
    placement: { group: 'access', level: 'manage' },
    risk: 'sensitive',
    selectors: [],
  },
  canonicalPath: '/access/changes',
  descriptionKey: 'shell.accessAdmin.changes.description',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.page.access-changes',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-access-changes',
  indexable: false,
  localisedPaths: { cs: '/access/changes', en: '/access/changes' },
  mfBoundaryId: 'shellSuperApp',
  namespace: 'shell',
  ownerAppId: 'shell-super-app',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'shell.accessAdmin.changes.title',
});

export default routeMeta;
export { routeMeta };
