import { defineSystemModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/resources/:moduleId/:resourceType/:resourceId',
  descriptionKey: 'shell.resource.seoDescription',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    entrypointKey: 'shell-super-app.page.resource-detail',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-resource-detail',
  indexable: false,
  localisedPaths: {
    cs: '/zdroje/:moduleId/:resourceType/:resourceId',
    en: '/resources/:moduleId/:resourceType/:resourceId',
  },
  mfBoundaryId: 'shellSuperApp',
  namespace: 'shell',
  ownerAppId: 'shell-super-app',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'shell.resource.title',
} as const;

export default routeMeta;
export { routeMeta };
