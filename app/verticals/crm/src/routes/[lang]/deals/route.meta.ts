import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/deals',
  descriptionKey: 'crm.pages.deals.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'crm.core.page.deals',
    moduleKey: 'crm.core',
    role: 'page',
  }),
  id: 'crm-deals',
  indexable: false,
  localisedPaths: {
    cs: '/deals',
    en: '/deals',
  },
  mfBoundaryId: 'verticalCrm',
  moduleId: 'crm.core',
  namespace: 'crm',
  ownerAppId: 'crm',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm.pages.deals.title',
} as const;

export default routeMeta;
export { routeMeta };
