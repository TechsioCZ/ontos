import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/crm/schvalovani-ai',
  descriptionKey: 'crm.pages.ai.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'demo.crm.write_all' },
    entrypointKey: 'demo.crm.page.ai',
    moduleKey: 'demo.crm',
    role: 'page',
  }),
  id: 'crm-ai',
  indexable: false,
  localisedPaths: {
    cs: '/crm/schvalovani-ai',
    en: '/crm/schvalovani-ai',
  },
  mfBoundaryId: 'verticalCrm',
  moduleId: 'demo.crm',
  namespace: 'crm',
  ownerAppId: 'crm',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm.pages.ai.title',
} as const;

export default routeMeta;
export { routeMeta };
