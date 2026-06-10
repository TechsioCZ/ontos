export const ultramodernRouteNamespace = 'shell' as const;

export const ultramodernRouteMetadata = [
  {
    canonicalPath: '/',
    id: 'shell-home',
    indexable: false,
    localisedPaths: {
      cs: '/',
      en: '/',
    },
    mfBoundaryId: 'shellSuperApp',
    namespace: 'shell',
    ownerAppId: 'shell-super-app',
    public: false,
    publicSurface: 'private-app-screen',
    titleKey: 'shell.title',
  },
  {
    canonicalPath: '/property-registry',
    id: 'property-registry',
    indexable: false,
    localisedPaths: {
      cs: '/property-registry',
      en: '/property-registry',
    },
    mfBoundaryId: 'shellSuperApp',
    namespace: 'shell',
    ownerAppId: 'property.registry',
    public: false,
    publicSurface: 'private-app-screen',
    titleKey: 'shell.routes.propertyRegistry',
  },
  {
    canonicalPath: '/accounting-core',
    id: 'accounting-core',
    indexable: false,
    localisedPaths: {
      cs: '/accounting-core',
      en: '/accounting-core',
    },
    mfBoundaryId: 'shellSuperApp',
    namespace: 'shell',
    ownerAppId: 'accounting.core',
    public: false,
    publicSurface: 'private-app-screen',
    titleKey: 'shell.routes.accountingCore',
  },
] as const;

export const ultramodernLocalisedUrls = {
  '/accounting-core': {
    cs: '/accounting-core',
    en: '/accounting-core',
  },
  '/property-registry': {
    cs: '/property-registry',
    en: '/property-registry',
  },
} as const;

export const ultramodernPublicRoutes = [] as const;

export const ultramodernRouteConfig = {
  localisedUrls: ultramodernLocalisedUrls,
  namespace: ultramodernRouteNamespace,
  publicRoutes: ultramodernPublicRoutes,
  routes: ultramodernRouteMetadata,
  source: 'route-owned',
} as const;
