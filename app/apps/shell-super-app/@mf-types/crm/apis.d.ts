
    export type RemoteKeys = 'crm/PageCustomers' | 'crm/PageDeals' | 'crm/PageCustomers.data';
    type PackageType<T> = T extends 'crm/PageCustomers.data' ? typeof import('crm/PageCustomers.data') :T extends 'crm/PageDeals' ? typeof import('crm/PageDeals') :T extends 'crm/PageCustomers' ? typeof import('crm/PageCustomers') :any;