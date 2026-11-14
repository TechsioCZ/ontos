import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'demo.crm.page-clients.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'crm', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/crm/klienti',
  descriptionKey: 'crm.pages.clients.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'demo.crm.page.clients',
    moduleKey: 'demo.crm',
    role: 'page',
  }),
  id: 'crm-clients',
  indexable: false,
  localisedPaths: {
    cs: '/crm/klienti',
    en: '/crm/klienti',
  },
  mfBoundaryId: 'verticalCrm',
  moduleId: 'demo.crm',
  namespace: 'crm',
  ownerAppId: 'crm',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm.pages.clients.title',
});

export default routeMeta;
export { routeMeta };
