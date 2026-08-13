
    export type RemoteKeys = 'crm/PageCustomers' | 'crm/PageDeals';
    type PackageType<T> = T extends 'crm/PageDeals' ? typeof import('crm/PageDeals') :T extends 'crm/PageCustomers' ? typeof import('crm/PageCustomers') :any;