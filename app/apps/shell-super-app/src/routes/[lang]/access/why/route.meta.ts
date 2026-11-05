import { defineSystemModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    admitsAdminSurface: true,
    key: 'shell-super-app.access-admin.explain',
    kind: 'admin',
    modes: ['run'],
    placement: { group: 'access', level: 'manage' },
    risk: 'sensitive',
    selectors: [],
  },
  canonicalPath: '/access/why',
  descriptionKey: 'shell.accessAdmin.why.seo.description',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.page.access-why',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-access-why',
  indexable: false,
  localisedPaths: { cs: '/access/why', en: '/access/why' },
  mfBoundaryId: 'shellSuperApp',
  namespace: 'shell',
  ownerAppId: 'shell-super-app',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'shell.accessAdmin.why.title',
});

export default routeMeta;
export { routeMeta };
