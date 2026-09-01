import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/crm',
  descriptionKey: 'crm.pages.crm.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'crm.core.page.crm',
    moduleKey: 'crm.core',
    role: 'page',
  }),
  id: 'crm-crm',
  indexable: false,
  localisedPaths: {
    cs: '/crm',
    en: '/crm',
  },
  mfBoundaryId: 'verticalCrm',
  moduleId: 'crm.core',
  namespace: 'crm',
  ownerAppId: 'crm',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm.pages.crm.title',
} as const;

export default routeMeta;
export { routeMeta };
