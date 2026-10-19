import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/crm/parovani',
  descriptionKey: 'crm.pages.pairing.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'demo.crm.page.pairing',
    moduleKey: 'demo.crm',
    role: 'page',
  }),
  id: 'crm-pairing',
  indexable: false,
  localisedPaths: {
    cs: '/crm/parovani',
    en: '/crm/parovani',
  },
  mfBoundaryId: 'verticalCrm',
  moduleId: 'demo.crm',
  namespace: 'crm',
  ownerAppId: 'crm',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm.pages.pairing.title',
} as const;

export default routeMeta;
export { routeMeta };
