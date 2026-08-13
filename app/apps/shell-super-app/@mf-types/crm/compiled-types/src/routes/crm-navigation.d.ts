type CrmPage = 'customers' | 'deals';
export declare const crmNavigationHref: (page: CrmPage, options: {
    readonly embedded: boolean;
    readonly language: string;
}) => string;
export {};
