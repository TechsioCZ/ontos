import { defineSystemModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    admitsAdminSurface: true,
    key: 'shell-super-app.access-roles.view',
    kind: 'admin',
    modes: ['run'],
    placement: { group: 'access', level: 'manage' },
    risk: 'sensitive',
    selectors: [],
  },
  canonicalPath: '/access/roles',
  descriptionKey: 'shell.accessAdmin.role.seo.description',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.page.access-roles',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-access-roles',
  indexable: false,
  localisedPaths: { cs: '/access/roles', en: '/access/roles' },
  mfBoundaryId: 'shellSuperApp',
  namespace: 'shell',
  ownerAppId: 'shell-super-app',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'shell.accessAdmin.role.seo.title',
});

export default routeMeta;
export { routeMeta };
