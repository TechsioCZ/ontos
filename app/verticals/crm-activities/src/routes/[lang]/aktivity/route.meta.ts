import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'crm.activities.page-records.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'crm-activities', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/aktivity',
  descriptionKey: 'crm-activities.pages.records.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
