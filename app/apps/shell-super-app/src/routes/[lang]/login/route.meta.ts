const routeMeta = {
  canonicalPath: '/login',
  descriptionKey: 'shell.login.seo.description',
  id: 'shell-login',
  indexable: false,
  localisedPaths: {
    cs: '/login',
    en: '/login',
  },
  mfBoundaryId: 'shellSuperApp',
  namespace: 'shell',
  ownerAppId: 'shell-super-app',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'shell.login.title',
} as const;

export default routeMeta;
export { routeMeta };
