import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'crm.activities.page-crm-activities-home.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'crm-activities', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/',
  descriptionKey: 'crm-activities.seo.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
