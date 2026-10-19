import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/crm/importy',
  descriptionKey: 'crm.pages.imports.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'demo.crm.page.imports',
    moduleKey: 'demo.crm',
    role: 'page',
  }),
  id: 'crm-imports',
  indexable: false,
  localisedPaths: {
    cs: '/crm/importy',
    en: '/crm/importy',
  },
  mfBoundaryId: 'verticalCrm',
  moduleId: 'demo.crm',
  namespace: 'crm',
  ownerAppId: 'crm',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm.pages.imports.title',
} as const;

export default routeMeta;
export { routeMeta };
