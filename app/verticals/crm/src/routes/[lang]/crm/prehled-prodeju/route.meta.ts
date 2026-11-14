import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'demo.crm.page-reports.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'crm', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/crm/prehled-prodeju',
  descriptionKey: 'crm.pages.reports.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'demo.crm.page.reports',
    moduleKey: 'demo.crm',
    role: 'page',
  }),
  id: 'crm-reports',
  indexable: false,
  localisedPaths: {
    cs: '/crm/prehled-prodeju',
    en: '/crm/prehled-prodeju',
  },
  mfBoundaryId: 'verticalCrm',
  moduleId: 'demo.crm',
  namespace: 'crm',
  ownerAppId: 'crm',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'crm.pages.reports.title',
});

export default routeMeta;
export { routeMeta };
