import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/crm/navstevy',
  descriptionKey: 'crm.pages.visits.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'demo.crm.page.visits',
    moduleKey: 'demo.crm',
    role: 'page',
  }),
  id: 'crm-visits',
  indexable: false,
  localisedPaths: {
    cs: '/crm/navstevy',
    en: '/crm/navstevy',
  },
  mfBoundaryId: 'verticalCrm',
  moduleId: 'demo.crm',
  namespace: 'crm',
  ownerAppId: 'crm',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm.pages.visits.title',
} as const;

export default routeMeta;
export { routeMeta };
