import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';
import { defineRouteMeta } from '@app/core-runtime/route-meta';

const routeMeta = defineRouteMeta({
  accessDeclaration: {
    key: 'demo.crm.page-ai.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'crm', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/crm/schvalovani-ai',
  descriptionKey: 'crm.pages.ai.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
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
});

export default routeMeta;
export { routeMeta };
