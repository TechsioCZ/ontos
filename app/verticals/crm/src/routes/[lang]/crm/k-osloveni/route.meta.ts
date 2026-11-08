import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'demo.crm.page-plan.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'crm', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/crm/k-osloveni',
  descriptionKey: 'crm.pages.plan.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
