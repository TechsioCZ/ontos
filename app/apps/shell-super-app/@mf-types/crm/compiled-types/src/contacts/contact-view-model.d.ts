export declare const contactFieldNames: readonly ['firstName', 'lastName', 'email', 'phone', 'jobTitle'];
export type ContactFieldName = (typeof contactFieldNames)[number];
export interface ContactFormValues {
    readonly email: string;
    readonly firstName: string;
    readonly jobTitle: string;
    readonly lastName: string;
    readonly phone: string;
}
export type ContactFormIssueCode = 'invalid_email' | 'name_required' | 'server_validation' | 'too_long';
export interface ContactFormIssue {
    readonly code: ContactFormIssueCode;
    readonly field?: ContactFieldName;
}
export interface ContactDetailModel {
    readonly contactId: string;
    readonly customerId: string;
    readonly email: string | null;
    readonly firstName: string | null;
    readonly jobTitle: string | null;
    readonly lastName: string | null;
    readonly phone: string | null;
    readonly version: number;
}
export interface ContactListRowModel {
    readonly contactId: string;
    readonly email: string | null;
    readonly firstName: string | null;
    readonly href: string;
    readonly jobTitle: string | null;
    readonly lastName: string | null;
    readonly phone: string | null;
    readonly selected: boolean;
}
export interface ContactPaginationModel {
    readonly nextHref?: string;
    readonly page: number;
}
export type ContactRouteValidationReason = 'foreign_selection' | 'invalid_cursor' | 'invalid_page' | 'invalid_selection' | 'policy';
interface ContactPanelContext {
    readonly customerId: string;
    readonly customerName: string;
}
export type ContactPanelModel = (ContactPanelContext & {
    readonly state: 'loading';
}) | (ContactPanelContext & {
    readonly pagination: ContactPaginationModel;
    readonly state: 'empty';
}) | (ContactPanelContext & {
    readonly reason: ContactRouteValidationReason;
    readonly resetHref: string;
    readonly state: 'validation';
}) | (ContactPanelContext & {
    readonly state: 'forbidden';
}) | (ContactPanelContext & {
    readonly state: 'not_found';
}) | (ContactPanelContext & {
    readonly retryHref: string;
    readonly state: 'conflict';
}) | (ContactPanelContext & {
    readonly retryHref: string;
    readonly state: 'unavailable';
}) | (ContactPanelContext & {
    readonly detail?: ContactDetailModel;
    readonly pagination: ContactPaginationModel;
    readonly rows: readonly ContactListRowModel[];
    readonly state: 'resolved';
});
export type ContactMutationResult = {
    readonly contact: ContactDetailModel;
    readonly state: 'success';
} | {
    readonly issues: readonly ContactFormIssue[];
    readonly state: 'validation';
} | {
    readonly state: 'conflict' | 'forbidden' | 'not_found' | 'unavailable';
};
export type ContactDeleteResult = {
    readonly state: 'success';
} | {
    readonly state: 'conflict' | 'forbidden' | 'not_found' | 'unavailable';
};
export interface ContactPanelCopy {
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
        readonly description: (contactName: string) => string;
        readonly pending: string;
        readonly title: string;
    };
    readonly detail: {
        readonly heading: string;
        readonly notProvided: string;
        readonly selectPrompt: string;
    };
    readonly fields: Readonly<Record<ContactFieldName, string>>;
    readonly form: {
        readonly createTitle: string;
        readonly editTitle: string;
        readonly pending: string;
        readonly summary: string;
    };
    readonly heading: (customerName: string) => string;
    readonly issues: Readonly<Record<ContactFormIssueCode, string>>;
    readonly list: {
        readonly caption: string;
        readonly email: string;
        readonly jobTitle: string;
        readonly name: string;
        readonly page: (page: number) => string;
        readonly phone: string;
    };
    readonly nameFallback: string;
    readonly states: {
        readonly conflict: string;
        readonly empty: string;
        readonly forbidden: string;
        readonly loading: string;
        readonly notFound: string;
        readonly readOnly: string;
        readonly unavailable: string;
        readonly validation: Readonly<Record<ContactRouteValidationReason, string>>;
    };
    readonly toast: {
        readonly created: string;
        readonly deleted: string;
        readonly updated: string;
    };
}
export interface ContactPanelProps {
    readonly copy: ContactPanelCopy;
    readonly model: ContactPanelModel;
    readonly onCreate: (values: ContactFormValues) => Promise<ContactMutationResult>;
    readonly onDelete: (contact: ContactDetailModel) => Promise<ContactDeleteResult>;
    readonly onEdit: (contact: ContactDetailModel, values: ContactFormValues) => Promise<ContactMutationResult>;
    readonly onMutationSuccess: () => void;
    readonly onNavigate: (href: string) => void;
    readonly onRetry: () => void;
    readonly writable: boolean;
}
export declare const emptyContactFormValues: ContactFormValues;
export declare const validateContactForm: (values: ContactFormValues) => readonly ContactFormIssue[];
export declare const formatContactDisplayName: (contact: Pick<ContactDetailModel, 'firstName' | 'lastName'>, fallback: string) => string;
export declare const contactFormValuesFromDetail: (contact: ContactDetailModel) => ContactFormValues;
export declare const contactFormToWritableFields: (values: ContactFormValues) => {
    email?: string;
    firstName?: string;
    jobTitle?: string;
    lastName?: string;
    phone?: string;
};
export {};
