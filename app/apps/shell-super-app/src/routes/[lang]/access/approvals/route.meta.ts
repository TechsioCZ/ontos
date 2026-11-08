import { defineSystemModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    admitsAdminSurface: true,
    key: 'shell-super-app.access-approvals.read',
    kind: 'admin',
    modes: ['run'],
    placement: { group: 'access-administration', level: 'manage' },
    risk: 'sensitive',
    selectors: [],
  },
  canonicalPath: '/access/approvals',
  descriptionKey: 'shell.accessAdmin.approvals.seo.description',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.page.access-approvals',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-access-approvals',
  indexable: false,
  localisedPaths: { cs: '/pristupy/ke-schvaleni', en: '/access/approvals' },
  mfBoundaryId: 'shellSuperApp',
  namespace: 'shell',
  ownerAppId: 'shell-super-app',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'shell.accessAdmin.approvals.title',
});

export default routeMeta;
export { routeMeta };
