import { defineSystemModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/projects/customers/:id/edit',
  descriptionKey: 'shell.moduleTarget.seoDescription',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    entrypointKey: 'shell-super-app.page.projects-customer-edit',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-projects-customer-edit',
  indexable: false,
  localisedPaths: {
    cs: '/projects/customers/:id/edit',
    en: '/projects/customers/:id/edit',
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
