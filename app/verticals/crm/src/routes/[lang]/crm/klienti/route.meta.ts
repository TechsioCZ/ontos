import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/crm/klienti',
  descriptionKey: 'crm.pages.clients.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
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
} as const;

export default routeMeta;
export { routeMeta };
