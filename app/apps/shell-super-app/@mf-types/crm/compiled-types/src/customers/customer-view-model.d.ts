import type { ContactPanelModel } from '../contacts/contact-view-model.ts';
export declare const customerFieldNames: readonly ['name', 'companyRegistrationNumber', 'taxIdentificationNumber', 'email', 'phone', 'website', 'addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'countryCode'];
export type CustomerFieldName = (typeof customerFieldNames)[number];
export interface CustomerFormValues {
    readonly addressLine1: string;
    readonly addressLine2: string;
    readonly city: string;
    readonly companyRegistrationNumber: string;
    readonly countryCode: string;
    readonly email: string;
    readonly name: string;
    readonly phone: string;
    readonly postalCode: string;
    readonly region: string;
    readonly taxIdentificationNumber: string;
    readonly website: string;
}
export type CustomerFormIssueCode = 'invalid_country_code' | 'invalid_email' | 'invalid_website' | 'required' | 'server_validation' | 'too_long';
export interface CustomerFormIssue {
    readonly code: CustomerFormIssueCode;
    readonly field?: CustomerFieldName;
}
export interface CustomerRecordModel {
    readonly address: {
        readonly addressLine1: string | null;
        readonly addressLine2: string | null;
        readonly city: string | null;
        readonly countryCode: string | null;
        readonly postalCode: string | null;
        readonly region: string | null;
    } | null;
    readonly companyRegistrationNumber: string | null;
    readonly customerId: string;
    readonly email: string | null;
    readonly name: string;
    readonly phone: string | null;
    readonly taxIdentificationNumber: string | null;
    readonly version: number;
    readonly website: string | null;
}
export interface CustomerListRowModel {
    readonly city: string | null;
    readonly companyRegistrationNumber: string | null;
    readonly customerId: string;
    readonly email: string | null;
    readonly href: string;
    readonly name: string;
    readonly selected: boolean;
}
export interface CustomerDetailFieldModel {
    readonly key: Exclude<CustomerFieldName, 'name'>;
    readonly value: string | null;
}
export interface CustomerDetailModel {
    readonly customerId: string;
    readonly fields: readonly CustomerDetailFieldModel[];
    readonly name: string;
    readonly version: number;
}
export interface CustomerPaginationModel {
    readonly nextHref?: string;
    readonly page: number;
}
export type CustomerRouteValidationReason = 'invalid_cursor' | 'invalid_page' | 'invalid_selection' | 'policy';
export type CustomerPageModel = {
    readonly state: 'loading';
} | {
    readonly pagination: CustomerPaginationModel;
    readonly state: 'empty';
} | {
    readonly reason: CustomerRouteValidationReason;
    readonly resetHref: string;
    readonly state: 'validation';
} | {
    readonly state: 'forbidden';
} | {
    readonly state: 'not_found';
} | {
    readonly retryHref: string;
    readonly state: 'unavailable';
} | {
    readonly contacts?: ContactPanelModel;
    readonly detail?: CustomerDetailModel;
    readonly pagination: CustomerPaginationModel;
    readonly rows: readonly CustomerListRowModel[];
    readonly state: 'resolved';
};
export type CustomerMutationResult = {
    readonly customer: CustomerRecordModel;
    readonly state: 'success';
} | {
    readonly issues: readonly CustomerFormIssue[];
    readonly state: 'validation';
} | {
    readonly state: 'conflict' | 'forbidden' | 'not_found' | 'unavailable';
};
export type CustomerDeleteResult = {
    readonly state: 'success';
} | {
    readonly state: 'conflict' | 'forbidden' | 'not_found' | 'unavailable';
};
export interface CustomerWorkspaceCopy {
    readonly actions: {
        readonly cancel: string;
        readonly create: string;
        readonly delete: string;
        readonly edit: string;
        readonly nextPage: string;
        readonly retry: string;
        readonly save: string;
    };
    readonly deleteDialog: {
        readonly description: (customerName: string) => string;
        readonly pending: string;
        readonly title: string;
    };
    readonly detail: {
        readonly heading: string;
        readonly notProvided: string;
        readonly selectPrompt: string;
    };
    readonly fields: Readonly<Record<CustomerFieldName, string>>;
    readonly form: {
        readonly createTitle: string;
        readonly editTitle: string;
        readonly pending: string;
        readonly summary: string;
    };
    readonly issues: Readonly<Record<CustomerFormIssueCode, string>>;
    readonly list: {
        readonly caption: string;
        readonly city: string;
        readonly companyRegistrationNumber: string;
        readonly email: string;
        readonly name: string;
        readonly page: (page: number) => string;
    };
    readonly states: {
        readonly conflict: string;
        readonly empty: string;
        readonly forbidden: string;
        readonly loading: string;
        readonly notFound: string;
        readonly readOnly: string;
        readonly unavailable: string;
        readonly validation: Readonly<Record<CustomerRouteValidationReason, string>>;
    };
    readonly toast: {
        readonly created: string;
        readonly deleted: string;
        readonly updated: string;
    };
}
export interface CustomerWorkspaceProps {
    readonly copy: CustomerWorkspaceCopy;
    readonly model: CustomerPageModel;
    readonly onCreate: (values: CustomerFormValues) => Promise<CustomerMutationResult>;
    readonly onDelete: (customer: CustomerDetailModel) => Promise<CustomerDeleteResult>;
    readonly onEdit: (customer: CustomerDetailModel, values: CustomerFormValues) => Promise<CustomerMutationResult>;
    readonly onNavigate: (href: string) => void;
    readonly onRetry: () => void;
    readonly writable: boolean;
}
export declare const emptyCustomerFormValues: CustomerFormValues;
export declare const validateCustomerForm: (values: CustomerFormValues) => readonly CustomerFormIssue[];
export declare const customerFormValuesFromDetail: (detail: CustomerDetailModel) => CustomerFormValues;
export declare const customerRecordToDetail: (customer: CustomerRecordModel) => CustomerDetailModel;
export declare const customerFormToWritableFields: (values: CustomerFormValues) => {
    address?: {
        addressLine1?: string;
        addressLine2?: string;
        city?: string;
        countryCode?: string;
        postalCode?: string;
        region?: string;
    };
    companyRegistrationNumber?: string;
    email?: string;
    name: string;
    phone?: string;
    taxIdentificationNumber?: string;
    website?: string;
};
