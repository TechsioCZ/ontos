import { defineSystemModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    admitsAdminSurface: true,
    key: 'shell-super-app.access-admin.agents',
    kind: 'admin',
    modes: ['run'],
    placement: { group: 'access', level: 'manage' },
    risk: 'sensitive',
    selectors: [],
  },
  canonicalPath: '/access/agents',
  descriptionKey: 'shell.accessAdmin.agents.seo.description',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.page.access-agents',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-access-agents',
  indexable: false,
  localisedPaths: { cs: '/access/agents', en: '/access/agents' },
  mfBoundaryId: 'shellSuperApp',
  namespace: 'shell',
  ownerAppId: 'shell-super-app',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'shell.accessAdmin.agents.title',
});

export default routeMeta;
export { routeMeta };
