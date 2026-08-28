import { defineSystemModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/projects/customers/:id',
  descriptionKey: 'shell.moduleTarget.seoDescription',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    entrypointKey: 'shell-super-app.page.projects-customer-detail',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-projects-customer-detail',
  indexable: false,
  localisedPaths: {
    cs: '/projects/customers/:id',
    en: '/projects/customers/:id',
  },
  mfBoundaryId: 'shellSuperApp',
  namespace: 'shell',
  ownerAppId: 'shell-super-app',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'shell.moduleTarget.title',
} as const;

export default routeMeta;
export { routeMeta };
