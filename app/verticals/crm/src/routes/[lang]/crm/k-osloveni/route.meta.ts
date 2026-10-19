import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/crm/k-osloveni',
  descriptionKey: 'crm.pages.plan.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'demo.crm.page.plan',
    moduleKey: 'demo.crm',
    role: 'page',
  }),
  id: 'crm-plan',
  indexable: false,
  localisedPaths: {
    cs: '/crm/k-osloveni',
    en: '/crm/k-osloveni',
  },
  mfBoundaryId: 'verticalCrm',
  moduleId: 'demo.crm',
  namespace: 'crm',
  ownerAppId: 'crm',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm.pages.plan.title',
} as const;

export default routeMeta;
export { routeMeta };
