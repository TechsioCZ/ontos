import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '/aktivity',
  descriptionKey: 'crm-activities.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'crm.activities.page.records',
    moduleKey: 'crm.activities',
    role: 'page',
  }),
  id: 'crm-activities-records',
  indexable: false,
  localisedPaths: {
    cs: '/aktivity',
    en: '/aktivity',
  },
  mfBoundaryId: 'verticalCrmActivities',
  moduleId: 'crm.activities',
  namespace: 'crm-activities',
  ownerAppId: 'crm-activities',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm-activities.pages.records.title',
} as const;

export default routeMeta;
export { routeMeta };
