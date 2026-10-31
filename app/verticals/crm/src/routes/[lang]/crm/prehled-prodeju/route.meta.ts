import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/crm/prehled-prodeju',
  descriptionKey: 'crm.pages.reports.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'demo.crm.page.reports',
    moduleKey: 'demo.crm',
    role: 'page',
  }),
  id: 'crm-reports',
  indexable: false,
  localisedPaths: {
    cs: '/crm/prehled-prodeju',
    en: '/crm/prehled-prodeju',
  },
  mfBoundaryId: 'verticalCrm',
  moduleId: 'demo.crm',
  namespace: 'crm',
  ownerAppId: 'crm',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm.pages.reports.title',
} as const;

export default routeMeta;
export { routeMeta };
