export declare const ultramodernRouteNamespace: 'crm';
export declare const ultramodernRouteMetadata: readonly [{
    readonly canonicalPath: '/';
    readonly descriptionKey: 'crm.seo.description';
    readonly entrypoint: {
        readonly access: 'read';
        readonly entrypointKey: 'crm.core.page.home';
        readonly moduleKey: 'crm.core';
        readonly role: 'page';
        readonly scope: 'tenant';
    };
    readonly id: 'crm-home';
    readonly indexable: false;
    readonly localisedPaths: {
        readonly cs: '/';
        readonly en: '/';
    };
    readonly mfBoundaryId: 'verticalCrm';
    readonly namespace: 'crm';
    readonly ownerAppId: 'crm';
    readonly public: false;
    readonly publicSurface: 'private-app-screen';
    readonly titleKey: 'crm.title';
}, {
    readonly canonicalPath: '/customers';
    readonly descriptionKey: 'crm.pages.customers.description';
    readonly entrypoint: {
        readonly access: 'read';
        readonly entrypointKey: 'crm.core.page.customers';
        readonly moduleKey: 'crm.core';
        readonly role: 'page';
        readonly scope: 'tenant';
    };
    readonly id: 'crm-customers';
    readonly indexable: false;
    readonly localisedPaths: {
        readonly cs: '/customers';
        readonly en: '/customers';
    };
    readonly mfBoundaryId: 'verticalCrm';
    readonly moduleId: 'crm.core';
    readonly namespace: 'crm';
    readonly ownerAppId: 'crm';
    readonly public: false;
    readonly publicSurface: 'private-app-screen';
    readonly titleKey: 'crm.pages.customers.title';
}, {
    readonly canonicalPath: '/deals';
    readonly descriptionKey: 'crm.pages.deals.description';
    readonly entrypoint: {
        readonly access: 'read';
        readonly entrypointKey: 'crm.core.page.deals';
        readonly moduleKey: 'crm.core';
        readonly role: 'page';
        readonly scope: 'tenant';
    };
    readonly id: 'crm-deals';
    readonly indexable: false;
    readonly localisedPaths: {
        readonly cs: '/deals';
        readonly en: '/deals';
    };
    readonly mfBoundaryId: 'verticalCrm';
    readonly moduleId: 'crm.core';
    readonly namespace: 'crm';
    readonly ownerAppId: 'crm';
    readonly public: false;
    readonly publicSurface: 'private-app-screen';
    readonly titleKey: 'crm.pages.deals.title';
}];
export declare const ultramodernLocalisedUrls: {
    readonly '/customers': {
        readonly cs: '/customers';
        readonly en: '/customers';
    };
    readonly '/deals': {
        readonly cs: '/deals';
        readonly en: '/deals';
    };
};
export declare const ultramodernPublicRoutes: readonly [];
export declare const ultramodernRouteConfig: {
    readonly authoring: 'colocated-route-meta';
    readonly generatedManifest: true;
    readonly localisedUrls: {
        readonly '/customers': {
            readonly cs: '/customers';
            readonly en: '/customers';
        };
        readonly '/deals': {
            readonly cs: '/deals';
            readonly en: '/deals';
        };
    };
    readonly namespace: "crm";
    readonly publicRoutes: readonly [];
    readonly routes: readonly [{
        readonly canonicalPath: '/';
        readonly descriptionKey: 'crm.seo.description';
        readonly entrypoint: {
            readonly access: 'read';
            readonly entrypointKey: 'crm.core.page.home';
            readonly moduleKey: 'crm.core';
            readonly role: 'page';
            readonly scope: 'tenant';
        };
        readonly id: 'crm-home';
        readonly indexable: false;
        readonly localisedPaths: {
            readonly cs: '/';
            readonly en: '/';
        };
        readonly mfBoundaryId: 'verticalCrm';
        readonly namespace: 'crm';
        readonly ownerAppId: 'crm';
        readonly public: false;
        readonly publicSurface: 'private-app-screen';
        readonly titleKey: 'crm.title';
    }, {
        readonly canonicalPath: '/customers';
        readonly descriptionKey: 'crm.pages.customers.description';
        readonly entrypoint: {
            readonly access: 'read';
            readonly entrypointKey: 'crm.core.page.customers';
            readonly moduleKey: 'crm.core';
            readonly role: 'page';
            readonly scope: 'tenant';
        };
        readonly id: 'crm-customers';
        readonly indexable: false;
        readonly localisedPaths: {
            readonly cs: '/customers';
            readonly en: '/customers';
        };
        readonly mfBoundaryId: 'verticalCrm';
        readonly moduleId: 'crm.core';
        readonly namespace: 'crm';
        readonly ownerAppId: 'crm';
        readonly public: false;
        readonly publicSurface: 'private-app-screen';
        readonly titleKey: 'crm.pages.customers.title';
    }, {
        readonly canonicalPath: '/deals';
        readonly descriptionKey: 'crm.pages.deals.description';
        readonly entrypoint: {
            readonly access: 'read';
            readonly entrypointKey: 'crm.core.page.deals';
            readonly moduleKey: 'crm.core';
            readonly role: 'page';
            readonly scope: 'tenant';
        };
        readonly id: 'crm-deals';
        readonly indexable: false;
        readonly localisedPaths: {
            readonly cs: '/deals';
            readonly en: '/deals';
        };
        readonly mfBoundaryId: 'verticalCrm';
        readonly moduleId: 'crm.core';
        readonly namespace: 'crm';
        readonly ownerAppId: 'crm';
        readonly public: false;
        readonly publicSurface: 'private-app-screen';
        readonly titleKey: 'crm.pages.deals.title';
    }];
    readonly source: 'route-owned';
};
