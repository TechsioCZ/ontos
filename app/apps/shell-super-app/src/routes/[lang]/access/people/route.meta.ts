import { defineSystemModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    admitsAdminSurface: true,
    key: 'shell-super-app.access-admin.people',
    kind: 'admin',
    modes: ['run'],
    placement: { group: 'access', level: 'manage' },
    risk: 'sensitive',
    selectors: [],
  },
  canonicalPath: '/access/people',
  descriptionKey: 'shell.accessAdmin.people.description',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.page.access-people',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-access-people',
  indexable: false,
  localisedPaths: { cs: '/access/people', en: '/access/people' },
  mfBoundaryId: 'shellSuperApp',
  namespace: 'shell',
  ownerAppId: 'shell-super-app',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'shell.accessAdmin.people.title',
});

export default routeMeta;
export { routeMeta };
