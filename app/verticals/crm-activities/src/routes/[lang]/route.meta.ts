import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/',
  descriptionKey: 'crm-activities.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'crm.activities.page.crm-activities-home',
    moduleKey: 'crm.activities',
    role: 'page',
  }),
  id: 'crm-activities-home',
  indexable: false,
  localisedPaths: {
    cs: '/',
    en: '/',
  },
  mfBoundaryId: 'verticalCrmActivities',
  moduleId: 'crm.activities',
  namespace: 'crm-activities',
  ownerAppId: 'crm-activities',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm-activities.title',
} as const;

export default routeMeta;
export { routeMeta };
